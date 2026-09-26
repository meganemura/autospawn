// Responsibility: the one-line control header exchanged right after a
// socket connects, and the argv fingerprint used to detect a mismatched
// spawn command. Everything after the header is an opaque byte relay that
// this module does not touch.
//
// Not done here: interpreting MCP/JSON-RPC content (mcp-autospawn never
// parses the traffic it relays); enforcing the header timeout against a
// clock (callers pass in the deadline so this module stays testable without
// fake timers).
import crypto from "node:crypto";
import type { Socket } from "node:net";

export const MAX_HEADER_BYTES = 64 * 1024;
export const HEADER_TIMEOUT_MS = 5000;

export type AttachHeader = { v: 1; op: "attach"; fingerprint: string };
export type StopHeader = { v: 1; op: "stop" };
export type ClientHeader = AttachHeader | StopHeader;

export type OkReply = { ok: true };
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
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const finish = (err: Error | null, value?: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
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
      if (done) return;
      done = true;
      cleanup();
      socket.pause();
      if (rest.length > 0) socket.unshift(rest);
      resolve(parsed);
    };

    const onError = (err: Error) => finish(err);
    const onClose = () => finish(new HeaderError("header_closed", "socket closed before header"));

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

export function isAttachHeader(v: unknown): v is AttachHeader {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { v?: unknown }).v === 1 &&
    (v as { op?: unknown }).op === "attach" &&
    typeof (v as { fingerprint?: unknown }).fingerprint === "string"
  );
}

export function isStopHeader(v: unknown): v is StopHeader {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { v?: unknown }).v === 1 &&
    (v as { op?: unknown }).op === "stop"
  );
}
