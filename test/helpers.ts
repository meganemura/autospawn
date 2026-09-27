// Test-only helpers: spawn the CLI as a real subprocess (never import
// connect.ts/serve.ts in-process, since the behavior under test is how
// separate processes interact over a socket), and manage short-lived state
// directories under /tmp so generated socket paths stay under the macOS
// sun_path limit.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const cliPath = path.join(here, "..", "src", "cli.ts");
export const fixturesDir = path.join(here, "fixtures");

// Hardcoded /tmp (not os.tmpdir()) by default, for the socket path length
// reason above; MCP_AUTOSPAWN_TEST_TMP overrides the parent directory so a
// mutation run (or anything else that wants its own leftovers contained)
// can point every test's state dir somewhere it fully controls and can
// remove in one step, instead of everything landing in shared /tmp.
export function testTmpParent(): string {
  const override = process.env.MCP_AUTOSPAWN_TEST_TMP;
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
// serve refuses to run without MCP_AUTOSPAWN_SOCKET, which is why this
// takes sockPath and fingerprint as the caller's own responsibility rather
// than deriving them the way connect would.
export function startServeDirect(
  sockPath: string,
  fingerprint: string,
  server = "echo-server",
  idleTimeoutSeconds = 10,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      cliPath,
      "serve",
      "--idle-timeout",
      String(idleTimeoutSeconds),
      "--",
      path.join(fixturesDir, server),
    ],
    {
      env: {
        ...process.env,
        MCP_AUTOSPAWN_SOCKET: sockPath,
        MCP_AUTOSPAWN_FINGERPRINT: fingerprint,
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
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

export function readCountFile(file: string): number {
  try {
    return fs.readFileSync(file, "utf8").length;
  } catch {
    return 0;
  }
}

export function baseEnv(stateDir: string): NodeJS.ProcessEnv {
  return { ...process.env, MCP_AUTOSPAWN_DIR: stateDir };
}

export const tmpdir = os.tmpdir;
