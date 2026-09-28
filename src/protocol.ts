// Responsibility: the one-line control header exchanged right after a
// socket connects, and the argv fingerprint used to detect a mismatched
// spawn command. Everything after the header is an opaque byte relay that
// this module does not touch.
//
// Not done here: interpreting the relayed content, MCP or otherwise (autospawn never
// parses the traffic it relays); enforcing the header timeout against a
// clock (callers pass in the deadline so this module stays testable without
// fake timers).
import crypto from "node:crypto";
import type { Socket } from "node:net";

export const MAX_HEADER_BYTES = 64 * 1024;
export const HEADER_TIMEOUT_MS = 5000;

// params carries per-connection values (ADR 0008). A connect with no
// --param leaves it out.
export type AttachHeader = {
  v: 1;
  op: "attach";
  fingerprint: string;
  params?: Readonly<Record<string, string>>;
  // 1 asks serve to frame its output (ADR 0009). A serve that does not
  // know the field ignores it and relays raw.
  frames?: number;
};
export type StopHeader = { v: 1; op: "stop" };
export type ClientHeader = AttachHeader | StopHeader;

// frames: 1 says serve frames its output on this connection.
export type OkReply = { ok: true; frames?: number };
export type ErrReply = { ok: false; error: string; message: string };
export type ServerReply = OkReply | ErrReply;

// Fingerprint covers argv only, never env: clients (Cursor, Claude Code,
// Codex) each add their own environment variables to a launched process, so
// including env would make the same configuration fingerprint differently
// depending on which client started it.
export function fingerprintArgv(argv: readonly string[]): string {
  const json = JSON.stringify(argv);
  return crypto.createHash("sha256").update(json).digest("hex");
}

export function encodeLine(obj: unknown): Buffer {
  // Stryker disable next-line StringLiteral: Buffer.from falls back to
  // utf8 for any unrecognized encoding name (measured: Buffer.from(s, "")
  // produces byte-for-byte the same output as Buffer.from(s, "utf8"), for
  // ASCII and multi-byte content alike), so a mutant that empties this
  // string has no observable effect.
  return Buffer.from(JSON.stringify(obj) + "\n", "utf8");
}

export class HeaderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Reads up to and including the first newline and parses it as JSON. Bytes
// that arrived after the newline (in the same or a later chunk read so far)
// go back onto the socket via unshift, so the caller loses nothing sent
// right after the header.
//
// Cleanup order on the success path matters: listeners come off and the
// socket is paused *before* unshift runs, so unshift never has a live
// "data" listener on the stream to re-enter (Node's own docs call
// unshifting onto a stream that still has a flowing listener undefined
// behavior). The caller must call socket.resume() itself, after it has
// attached whatever listener will consume the relay.
export function readHeaderLine(
  socket: Socket,
  { timeoutMs = HEADER_TIMEOUT_MS, maxBytes = MAX_HEADER_BYTES } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;

    const cleanup = () => {
      // Stryker disable next-line CallExpression: dropping this leaves
      // the timer running for up to timeoutMs after resolution, but its
      // callback finds done already true and calls finish(), whose own
      // "if (done) return" makes that a no-op -- no observable effect,
      // just an OS timer held open a little longer than necessary.
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.removeListener("end", onClose);
    };

    // Only failures settle through here. The success path in onData
    // resolves directly, because it must pause and unshift in between.
    const finish = (err: Error) => {
      // Stryker disable next-line ConditionalExpression: the only way
      // finish() runs twice is two of {timeout, onError, onClose} firing
      // for the same socket; a second reject()/resolve() on an
      // already-settled promise is a no-op per the Promise spec, so
      // skipping this guard has no observable effect.
      if (done) return;
      // Stryker disable next-line BooleanLiteral: same reasoning as
      // above -- nothing besides this guard reads `done` again.
      done = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      finish(new HeaderError("header_timeout", "header not received in time"));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > maxBytes) {
        finish(new HeaderError("header_too_large", "header exceeded size limit"));
        return;
      }
      const idx = buf.indexOf(0x0a);
      if (idx === -1) return;
      const line = buf.subarray(0, idx).toString("utf8");
      const rest = buf.subarray(idx + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        finish(new HeaderError("header_invalid", "header line is not valid JSON"));
        return;
      }
      // Stryker disable next-line ConditionalExpression: cleanup() below
      // has already removed this handler by the time any second call
      // could happen; the only way "done" could already be true here is
      // finish() having settled the promise first (a timeout or error
      // racing this success), and resolve()/reject() on an
      // already-settled promise is a no-op per the Promise spec, so
      // skipping this guard has no observable effect.
      if (done) return;
      // Stryker disable next-line BooleanLiteral: nothing downstream
      // reads `done` again on this path once cleanup() below has run
      // (the only other reader, finish(), can no longer be invoked for
      // this socket), so leaving it false here has no observable effect.
      done = true;
      cleanup();
      socket.pause();
      // Stryker disable next-line all: measured that Readable.unshift()
      // with an empty buffer emits no "data" event (Node treats a
      // zero-length push as a no-op), so calling it unconditionally
      // (ConditionalExpression) or on ">= 0" (EqualityOperator, always
      // true for a length) is equivalent to this guard.
      if (rest.length > 0) socket.unshift(rest);
      resolve(parsed);
    };

    const onError = (err: Error) => finish(err);
    const onClose = () => finish(new HeaderError("header_closed", "socket closed before header"));

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    // serve's sockets allow half open, so a peer that ends its side emits
    // "end" but no "close". A peer that ends before the header line will
    // never send one, so that counts as a close, not a wait for the timeout.
    socket.on("end", onClose);
  });
}

export function isAttachHeader(v: unknown): v is AttachHeader {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { v?: unknown }).v === 1 &&
    (v as { op?: unknown }).op === "attach" &&
    typeof (v as { fingerprint?: unknown }).fingerprint === "string" &&
    isParams((v as { params?: unknown }).params)
  );
}

function isParams(p: unknown): boolean {
  if (p === undefined) return true;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return false;
  return Object.values(p).every((value) => typeof value === "string");
}

export function isStopHeader(v: unknown): v is StopHeader {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { v?: unknown }).v === 1 &&
    (v as { op?: unknown }).op === "stop"
  );
}
