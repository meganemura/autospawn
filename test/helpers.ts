// Test-only helpers: spawn the CLI as a real subprocess (never import
// connect.ts/serve.ts in-process, since the behavior under test is how
// separate processes interact over a socket), and manage short-lived state
// directories under /tmp so generated socket paths stay under the macOS
// sun_path limit.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// serve's second, shortened for the suite. serve runs its ownership check
// once per second and counts --idle-timeout in seconds, and most of the
// suite's wall time was spent waiting on those. Every process a test starts
// inherits this through process.env. A test that waits on one of them uses
// units(n); a long --idle-timeout that only bounds a leftover resident is
// scaled up by the same factor, so its real length stays.
export const TIME_UNIT_MS = 200;
process.env.AUTOSPAWN_TEST_TIME_UNIT_MS = String(TIME_UNIT_MS);

export function units(n: number): number {
  return n * TIME_UNIT_MS;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const cliPath = path.join(here, "..", "src", "cli.ts");
export const fixturesDir = path.join(here, "fixtures");

// Hardcoded /tmp (not os.tmpdir()) by default, for the socket path length
// reason above; AUTOSPAWN_TEST_TMP overrides the parent directory so a
// mutation run (or anything else that wants its own leftovers contained)
// can point every test's state dir somewhere it fully controls and can
// remove in one step, instead of everything landing in shared /tmp.
export function testTmpParent(): string {
  const override = process.env.AUTOSPAWN_TEST_TMP;
  return override && override.length > 0 ? override : "/tmp";
}

export function makeStateDir(): string {
  return mkdtempSync(path.join(testTmpParent(), "mas-"));
}

export function removeStateDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

export type RunResult = { code: number | null; stdout: string; stderr: string };

export function runCli(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

export type RawRunResult = { code: number | null; stdout: Buffer; stderr: string };

// Like runCli, but keeps stdout as a Buffer instead of decoding it as
// UTF-8: for a relay test carrying arbitrary bytes (0x00, invalid UTF-8),
// decoding and re-encoding would corrupt the very bytes the test is
// checking arrive unchanged.
export function runCliBinary(
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; input: Buffer },
): Promise<RawRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(stdoutChunks), stderr }));
    child.stdin.write(opts.input);
    child.stdin.end();
  });
}

// Starts a connect subprocess without waiting for it to finish, for tests
// that need to interact with it while it runs (write to stdin, read partial
// stdout, kill it mid-flight).
export function spawnConnect(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [cliPath, "connect", ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Starts `serve` directly, bypassing connect, for tests that need to talk
// to it over a raw socket or drive races connect would not let them drive.
// serve refuses to run without AUTOSPAWN_SOCKET, which is why this
// takes sockPath and fingerprint as the caller's own responsibility rather
// than deriving them the way connect would.
//
// idleTimeoutSeconds null starts serve with no --idle-timeout; a caller that
// does so must kill it in its own cleanup. stderrFd, when given, receives
// serve's own log lines. env adds variables that serve passes on to its
// children; a name starting with AUTOSPAWN_ would be stripped.
export function startServeDirect(
  sockPath: string,
  fingerprint: string,
  server = "echo-server",
  idleTimeoutSeconds: number | null = 50,
  { stderrFd, env }: { stderrFd?: number; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const idleArgs = idleTimeoutSeconds === null ? [] : ["--idle-timeout", String(idleTimeoutSeconds)];
  return spawn(
    process.execPath,
    [cliPath, "serve", ...idleArgs, "--", path.join(fixturesDir, server)],
    {
      env: {
        ...process.env,
        ...env,
        AUTOSPAWN_SOCKET: sockPath,
        AUTOSPAWN_FINGERPRINT: fingerprint,
      },
      stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
    },
  );
}

// Connects to a resident's socket without connect, sends an attach header,
// and resolves once the resident answers ok. The socket then relays to the
// resident's child until the caller ends it.
export async function attachRaw(sockPath: string, fingerprint: string): Promise<net.Socket> {
  const sock = net.connect(sockPath);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  sock.write(JSON.stringify({ v: 1, op: "attach", fingerprint }) + "\n");
  const reply = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      sock.removeListener("data", onData);
      resolve(buf.slice(0, idx));
    };
    sock.on("data", onData);
    sock.once("error", reject);
  });
  if (reply !== '{"ok":true}') throw new Error(`attach refused: ${reply}`);
  return sock;
}

// Resolves with how a child process exited, or with "still running" once
// timeoutMs passes.
export function exitWithin(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | "still running"> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("still running"), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

export function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  check: () => boolean,
  { timeoutMs = 5000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await sleep(intervalMs);
  }
}

// True once serve accepts connections on sockPath. The file alone is not
// enough: bind creates it before listen, and a connect in between gets
// ECONNREFUSED. serve chmods the socket to 0600 after listen, so that mode
// marks a socket that is listening.
export function isListening(sockPath: string): boolean {
  try {
    return (fs.statSync(sockPath).mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

export function waitForListening(sockPath: string, timeoutMs = 5000): Promise<void> {
  return waitFor(() => isListening(sockPath), { timeoutMs });
}

export function readCountFile(file: string): number {
  try {
    return fs.readFileSync(file, "utf8").length;
  } catch {
    return 0;
  }
}

export function baseEnv(stateDir: string): NodeJS.ProcessEnv {
  return { ...process.env, AUTOSPAWN_DIR: stateDir };
}

export const tmpdir = os.tmpdir;
