// Responsibility: attach to a resident serve process, spawning one through
// the detached `__spawn` chain (see spawn-chain.ts) if none answers yet, then
// relay stdio to the socket byte for byte.
//
// Not done here: knowing what the spawn command does (op run, node, or
// anything else); parsing MCP traffic; writing anything but the relay to
// stdout (diagnostics go to stderr only, since stdout is the JSON-RPC
// channel a client reads).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net, { type Socket } from "node:net";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryConnect(sockPath: string): Promise<Socket | null> {
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fail(message: string, log: string): never {
  process.stderr.write(`mcp-autospawn connect: ${message} (log: ${log})\n`);
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
type LockRole = "holder" | "waiter";

function acquireOrWaitForLock(lockPath: string, staleAfterMs: number): LockRole {
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

function tryCreateLock(lockPath: string): boolean {
  try {
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    fs.chmodSync(lockPath, 0o600);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

function releaseLock(lockPath: string): void {
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
async function startChain(
  sockPath: string,
  log: string,
  fingerprint: string,
  spawnCommand: readonly string[],
): Promise<number> {
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1] ?? "", "__spawn", log, "--", ...spawnCommand],
    {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        MCP_AUTOSPAWN_FINGERPRINT: fingerprint,
        MCP_AUTOSPAWN_SOCKET: sockPath,
      },
    },
  );
  child.unref();

  const pid = await new Promise<number>((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        const n = Number.parseInt(buf.slice(0, idx), 10);
        if (Number.isFinite(n)) resolve(n);
        else reject(new Error("__spawn did not report a pid"));
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (buf.indexOf("\n") === -1) {
        reject(new Error(`__spawn exited before reporting a pid (code ${code})`));
      }
    });
  });
  return pid;
}

async function attachAndRelay(sock: Socket, fingerprint: string): Promise<never> {
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
        "mcp-autospawn connect: a resident is already running for this --name " +
          "with a different command. Run 'mcp-autospawn stop --name <name>' and " +
          "reconnect.\n",
      );
    } else {
      process.stderr.write(`mcp-autospawn connect: ${err.error}: ${err.message}\n`);
    }
    process.exit(1);
  }

  process.stdin.on("data", (chunk: Buffer) => sock.write(chunk));
  process.stdin.on("end", () => sock.end());
  sock.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  sock.on("close", () => {
    process.stdout.write("", () => process.exit(0));
  });
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
    } else if (Date.now() > deadPidGraceDeadline) {
      releaseLock(lockPath);
      fail("the spawned command exited before a resident answered", log);
    }

    if (Date.now() > deadline) {
      releaseLock(lockPath);
      fail(`timed out after ${timeoutSeconds}s waiting for a resident`, log);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
