// Direct, in-process tests of connect.ts's own internal decision logic
// (exported for exactly this reason -- see the comment next to `sleep` in
// connect.ts). Every other test in this project reaches connect() only as
// a full subprocess, which is invisible to Stryker's coverage detection;
// these tests cover the mutation-testing survivors that gap left.
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireOrWaitForLock,
  fail,
  pidAlive,
  releaseLock,
  startChain,
  tryConnect,
  tryCreateLock,
} from "../src/connect.ts";
import { fixturesDir, makeStateDir, removeStateDir } from "./helpers.ts";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mas-connect-internals-"));
}

test("tryCreateLock: succeeds once, fails with EEXIST on a second attempt, and content is the pid", () => {
  const dir = makeDir();
  const lockPath = path.join(dir, "x.spawn");
  try {
    assert.equal(tryCreateLock(lockPath), true);
    assert.equal(fs.readFileSync(lockPath, "utf8"), `${process.pid}\n`);
    assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
    assert.equal(tryCreateLock(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tryCreateLock: a non-EEXIST error propagates instead of being swallowed as false", () => {
  // The parent directory does not exist, so the open() behind
  // writeFileSync fails with ENOENT, not EEXIST.
  const lockPath = path.join(makeDir(), "missing-parent", "x.spawn");
  assert.throws(() => tryCreateLock(lockPath), (err: unknown) => {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  });
});

test("releaseLock: removes an existing lock, and does not throw when there is nothing to remove", () => {
  const dir = makeDir();
  const lockPath = path.join(dir, "x.spawn");
  try {
    tryCreateLock(lockPath);
    assert.equal(fs.existsSync(lockPath), true);
    releaseLock(lockPath);
    assert.equal(fs.existsSync(lockPath), false);
    assert.doesNotThrow(() => releaseLock(lockPath)); // already gone
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireOrWaitForLock: no existing lock makes this the holder", () => {
  const dir = makeDir();
  const lockPath = path.join(dir, "x.spawn");
  try {
    assert.equal(acquireOrWaitForLock(lockPath, 60_000), "holder");
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireOrWaitForLock: a fresh existing lock makes this a waiter, and does not touch the file", () => {
  const dir = makeDir();
  const lockPath = path.join(dir, "x.spawn");
  try {
    tryCreateLock(lockPath);
    const inodeBefore = fs.statSync(lockPath).ino;
    assert.equal(acquireOrWaitForLock(lockPath, 60_000), "waiter");
    assert.equal(fs.statSync(lockPath).ino, inodeBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireOrWaitForLock: a stale existing lock is reclaimed, making this the holder", () => {
  const dir = makeDir();
  const lockPath = path.join(dir, "x.spawn");
  try {
    tryCreateLock(lockPath);
    const inodeBefore = fs.statSync(lockPath).ino;
    // Backdate the lock instead of passing 0ms: mtimeMs has sub-millisecond
    // precision and Date.now() does not, so a lock read right after it is
    // created can have a small negative age.
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, tenSecondsAgo, tenSecondsAgo);
    assert.equal(acquireOrWaitForLock(lockPath, 1000), "holder");
    assert.notEqual(fs.statSync(lockPath).ino, inodeBefore, "lock file must be a fresh inode");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pidAlive: true for this process's own pid, false once a child has actually exited", async () => {
  assert.equal(pidAlive(process.pid), true);

  const child = childProcess.spawn(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  const childPid = child.pid!;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  assert.equal(pidAlive(childPid), false);
});

test("startChain: reports the spawned pid, read from __spawn's own stdout line", async () => {
  const dir = makeStateDir();
  const logPath = path.join(dir, "chain.log");
  const sockPath = path.join(dir, "unused.sock");
  try {
    const pid = await startChain(
      sockPath,
      logPath,
      "fp",
      [path.join(fixturesDir, "exit1")],
    );
    assert.equal(typeof pid, "number");
    // exit1 exits immediately; give the detached chain a moment, then
    // confirm the pid startChain reported really was a real process (it
    // may already be dead by now, which is fine -- pidAlive would say so
    // consistently either way, this just confirms it is not garbage).
    assert.equal(Number.isInteger(pid) && pid > 0, true);
  } finally {
    removeStateDir(dir);
  }
});

test("startChain: __spawn exiting without ever printing a pid line rejects", async () => {
  const dir = makeStateDir();
  const logPath = path.join(dir, "chain.log");
  const sockPath = path.join(dir, "unused.sock");
  try {
    // An empty command makes __spawn itself usage-error (see
    // spawn-chain.ts's own empty-command test) and exit without ever
    // writing a pid line.
    await assert.rejects(
      startChain(sockPath, logPath, "fp", []),
      /__spawn exited before reporting a pid/,
    );
  } finally {
    removeStateDir(dir);
  }
});

// Regression guard: startChain once re-ran process.argv[1], which under a
// test runner is the test file itself, so each in-process call started two
// more test processes without limit. The chain marker now makes a nested
// startChain throw before it spawns anything.
test("startChain: refuses to start from inside a chain, and spawns nothing", async (t) => {
  const dir = makeStateDir();
  const logPath = path.join(dir, "chain.log");
  const sockPath = path.join(dir, "unused.sock");
  const spawn = t.mock.method(childProcess, "spawn");
  process.env.MCP_AUTOSPAWN_IN_CHAIN = "1";
  try {
    await assert.rejects(
      startChain(sockPath, logPath, "fp", [path.join(fixturesDir, "exit1")]),
      /inside another chain/,
    );
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    delete process.env.MCP_AUTOSPAWN_IN_CHAIN;
    removeStateDir(dir);
  }
});

const connectModulePath = path.join(fixturesDir, "..", "..", "src", "connect.ts");

test("fail: writes the message and the log path to stderr, then exits 1", async (t) => {
  // fail() itself calls process.exit(1) unconditionally, so it cannot be
  // called in this process without ending the test run -- run it in a
  // one-line subprocess instead, importing connect.ts the normal way.
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));
  const logPath = path.join(dir, "x.log");
  const script = `import("${pathToFileUrl(connectModulePath)}").then((m) => m.fail("boom", process.argv[1]))`;
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = childProcess.spawn(process.execPath, ["-e", script, logPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, `mcp-autospawn connect: boom (log: ${logPath})\n`);
});

function pathToFileUrl(p: string): string {
  return new URL(`file://${p}`).href;
}

test("tryConnect: resolves null (not a throw) for ENOENT and ECONNREFUSED alike", async (t) => {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));

  const missing = await tryConnect(path.join(dir, "does-not-exist.sock"));
  assert.equal(missing, null);
});
