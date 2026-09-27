// Responsibility: attach to a resident serve process, spawning one through
// the detached `__spawn` chain (see spawn-chain.ts) if none answers yet, then
// relay stdio to the socket byte for byte.
//
// Not done here: knowing what the spawn command does (op run, node, or
// anything else); parsing the relayed traffic; writing anything but the
// relay to stdout (diagnostics go to stderr only, since stdout is the
// channel the client reads, JSON-RPC for an MCP client).
import childProcess from "node:child_process";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseDir, ensureBaseDir, logPath, socketPath, spawnLockPath } from "./paths.ts";
import {
  encodeLine,
  fingerprintArgv,
  readHeaderLine,
  type ErrReply,
  type ServerReply,
} from "./protocol.ts";

const POLL_INTERVAL_MS = 100;
const DEAD_PID_GRACE_MS = 500;
const DEFAULT_TIMEOUT_SECONDS = 120;

// The CLI entry point that startChain runs as the __spawn intermediate.
// Resolved from this module's own location, never from process.argv[1]:
// when a test runner imports this module, argv[1] is the test file, and
// re-running it from startChain made each test process start two more,
// without limit. cli sits next to this file with the same extension (.ts
// in src, .js in dist).
const CLI_PATH = fileURLToPath(
  new URL(`./cli${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

// Set in the environment of every chain startChain starts. A process that
// already has it is inside a chain, so starting another one from there is
// a recursion, and startChain refuses it.
const CHAIN_MARKER = "AUTOSPAWN_IN_CHAIN";

// Exported for direct, in-process testing of this module's own decision
// logic (lock lifecycle, chain startup, the attach handshake's error
// paths). Other tests reach connect() only as a subprocess, and Stryker
// cannot see coverage inside a subprocess. No behavior changes from this.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function tryConnect(sockPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    const onError = () => {
      sock.destroy();
      resolve(null);
    };
    sock.once("error", onError);
    sock.once("connect", () => {
      sock.removeListener("error", onError);
      resolve(sock);
    });
  });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function fail(message: string, log: string): never {
  process.stderr.write(`autospawn connect: ${message} (log: ${log})\n`);
  process.exit(1);
}

// Two connects that both find no resident and both spawn a chain would each
// trigger their own 1Password approval, even though only one resulting
// serve survives — the second approval is wasted and defeats the point of
// sharing a resident. This lock makes only one connect spawn; the rest wait
// on the socket instead.
//
// A lock file, not the socket bind, is what serializes this: the bind
// happens inside serve, after whatever approval the spawn command triggers.
// By the time a bind exists to race on, the second approval prompt (if any)
// has already been shown.
export type LockRole = "holder" | "waiter";

export function acquireOrWaitForLock(lockPath: string, staleAfterMs: number): LockRole {
  if (tryCreateLock(lockPath)) return "holder";

  let ageMs = Infinity;
  try {
    ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    // Gone already (the holder released it between our failed create and
    // this stat) — fall through as a waiter; the socket will answer soon.
  }
  if (ageMs < staleAfterMs) return "waiter";

  // Older than any connect's own timeout could legitimately still be
  // starting up: whoever wrote it is gone without cleaning up. Reclaim it
  // once; if that also loses (another connect reclaimed it first), wait.
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone
  }
  return tryCreateLock(lockPath) ? "holder" : "waiter";
}

export function tryCreateLock(lockPath: string): boolean {
  try {
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    fs.chmodSync(lockPath, 0o600);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

export function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone
  }
}

// Spawns the hidden __spawn intermediate, which detaches spawnCommand from
// this process tree and reports its pid, then reads that one line and
// returns the pid. Env carries the fingerprint and socket path through to
// spawnCommand, since op run (and similar wrappers) pass environment
// through by default.
export async function startChain(
  sockPath: string,
  log: string,
  fingerprint: string,
  spawnCommand: readonly string[],
): Promise<number> {
  if (process.env[CHAIN_MARKER]) {
    throw new Error("refusing to start a chain from inside another chain");
  }
  // No process.execArgv: under a test runner it holds the runner's own
  // flags, and neither .ts (type stripping) nor dist .js needs a flag.
  const child = childProcess.spawn(
    process.execPath,
    [CLI_PATH, "__spawn", log, "--", ...spawnCommand],
    {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        [CHAIN_MARKER]: "1",
        AUTOSPAWN_FINGERPRINT: fingerprint,
        AUTOSPAWN_SOCKET: sockPath,
      },
    },
  );
  // Stryker disable next-line CallExpression: this process only ever ends
  // through an explicit process.exit() (fail(), attachAndRelay's own exit
  // calls) or by hanging forever in the relay (attachAndRelay's returned
  // promise never resolves) -- no path here relies on the event loop
  // draining naturally, so unref'ing this child never changes whether or
  // when the process exits.
  child.unref();

  const pid = await new Promise<number>((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        // Stryker disable next-line UnaryOperator,MethodExpression:
        // Number.parseInt stops at the first non-digit character it meets,
        // and "\n" is never a digit, so parsing the full buf instead of
        // buf.slice(0, idx) -- or slicing at +1 instead of idx -- stops at
        // the same "\n" either way and yields the same number.
        const n = Number.parseInt(buf.slice(0, idx), 10);
        if (Number.isFinite(n)) resolve(n);
        else reject(new Error("__spawn did not report a pid"));
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      // Stryker disable next-line ConditionalExpression: this only runs
      // after the promise has already settled (resolve or reject above,
      // both unconditional once idx !== -1), so forcing this to true makes
      // reject() run against an already-settled promise -- a no-op, since
      // a settled promise cannot change state.
      if (buf.indexOf("\n") === -1) {
        reject(new Error(`__spawn exited before reporting a pid (code ${code})`));
      }
    });
  });
  return pid;
}

export async function attachAndRelay(sock: Socket, fingerprint: string): Promise<never> {
  await new Promise<void>((resolve, reject) => {
    sock.write(encodeLine({ v: 1, op: "attach", fingerprint }), (err) =>
      err ? reject(err) : resolve(),
    );
  });
  const reply = (await readHeaderLine(sock)) as ServerReply;
  if (!reply.ok) {
    const err = reply as ErrReply;
    if (err.error === "fingerprint_mismatch") {
      process.stderr.write(
        "autospawn connect: a resident is already running for this --name " +
          "with a different command. Run 'autospawn stop --name <name>' and " +
          "reconnect.\n",
      );
    } else {
      process.stderr.write(`autospawn connect: ${err.error}: ${err.message}\n`);
    }
    process.exit(1);
  }

  process.stdin.on("data", (chunk: Buffer) => sock.write(chunk));
  process.stdin.on("end", () => sock.end());
  sock.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  sock.on("close", () => {
    process.stdout.write("", () => process.exit(0));
  });
  // Stryker disable next-line StringLiteral,ArrowFunction,CallExpression: measured (three
  // probes: a same-process destroy(err), a destroy(err) from the accepting
  // side, and a SIGKILL of the peer's whole process) that a unix domain
  // socket's peer going away always surfaces here as "close" with
  // hadError false, never as an "error" event -- found no deterministic
  // way to reach this listener at all, in this process or the peer's.
  sock.on("error", () => process.exit(1));
  // readHeaderLine paused the socket after the reply line; resume it now
  // that the relay listener above is in place, so nothing sent right after
  // the reply is lost.
  sock.resume();
  return new Promise<never>(() => {});
}

export async function connect(
  name: string,
  timeoutSeconds: number = DEFAULT_TIMEOUT_SECONDS,
  spawnCommand: readonly string[],
): Promise<never> {
  const base = baseDir();
  ensureBaseDir(base);
  const sockPath = socketPath(base, name);
  const log = logPath(base, name);
  const lockPath = spawnLockPath(base, name);
  const fingerprint = fingerprintArgv(spawnCommand);

  const existing = await tryConnect(sockPath);
  if (existing) return attachAndRelay(existing, fingerprint);

  const deadline = Date.now() + timeoutSeconds * 1000;
  const role = acquireOrWaitForLock(lockPath, timeoutSeconds * 1000);

  if (role === "waiter") {
    // Someone else's connect is already starting the chain (or was, until
    // it aged out and got reclaimed above); do not spawn a second one.
    // There is no pid to watch here, so the deadline is the only way out.
    for (;;) {
      const sock = await tryConnect(sockPath);
      if (sock) return attachAndRelay(sock, fingerprint);
      // Stryker disable next-line EqualityOperator: differs from > only at
      // the exact millisecond deadline falls on, and this loop only checks
      // the clock once per POLL_INTERVAL_MS (100ms) tick -- landing on
      // that one millisecond is not a case a test can reach on purpose.
      if (Date.now() > deadline) {
        fail(`timed out after ${timeoutSeconds}s waiting for a resident`, log);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  let pid: number;
  try {
    pid = await startChain(sockPath, log, fingerprint, spawnCommand);
  } catch (err) {
    releaseLock(lockPath);
    throw err;
  }

  let deadPidGraceDeadline: number | null = null;
  for (;;) {
    const sock = await tryConnect(sockPath);
    if (sock) {
      releaseLock(lockPath);
      return attachAndRelay(sock, fingerprint);
    }

    if (deadPidGraceDeadline === null) {
      if (!pidAlive(pid)) {
        deadPidGraceDeadline = Date.now() + DEAD_PID_GRACE_MS;
      }
    } else {
      // Stryker disable next-line EqualityOperator: differs from > only at
      // the exact millisecond deadPidGraceDeadline falls on, and this loop
      // only checks the clock once per POLL_INTERVAL_MS (100ms) tick --
      // landing on that one millisecond is not a case a test can reach on
      // purpose.
      if (Date.now() > deadPidGraceDeadline) {
        releaseLock(lockPath);
        fail("the spawned command exited before a resident answered", log);
      }
    }

    // Stryker disable next-line EqualityOperator: same reasoning as the
    // waiter loop's own deadline check above -- unreachable at exactly the
    // right millisecond under 100ms polling.
    if (Date.now() > deadline) {
      releaseLock(lockPath);
      fail(`timed out after ${timeoutSeconds}s waiting for a resident`, log);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
