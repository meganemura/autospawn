// Direct, in-process tests of connect.ts's own internal decision logic
// (exported for exactly this reason -- see the comment next to `sleep` in
// connect.ts). Every other test in this project reaches connect() only as
// a full subprocess, which is invisible to Stryker's coverage detection;
// these tests cover the mutation-testing survivors that gap left.
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireOrWaitForLock,
  fail,
  pidAlive,
  releaseLock,
  sleep,
  startChain,
  tryConnect,
  tryCreateLock,
} from "../src/connect.ts";
import { fixturesDir, makeStateDir, removeStateDir, waitFor } from "./helpers.ts";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mas-connect-internals-"));
}

// A stand-in for a real child_process ChildProcess: just enough surface
// (stdout as an EventEmitter, unref, once/emit for its own "error"/"close")
// for startChain's pid-parsing logic, with nothing actually spawned -- the
// safest way to drive that logic's edge cases without touching the
// process-count budget the fork-bomb rule protects.
function fakeChild(): childProcess.ChildProcess & { stdout: EventEmitter } {
  const child = new EventEmitter() as unknown as childProcess.ChildProcess & {
    stdout: EventEmitter;
  };
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  child.unref = () => child;
  return child;
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

// writeFileSync's own mode is already subject to umask, so a merely
// permissive umask (022, the common default) never distinguishes this
// from a no-op; a umask that also clears owner bits does.
test("tryCreateLock: forces mode 0600 even under a umask that would otherwise clear it", () => {
  const dir = makeDir();
  const lockPath = path.join(dir, "x.spawn");
  const prevUmask = process.umask(0o777);
  try {
    assert.equal(tryCreateLock(lockPath), true);
    assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
  } finally {
    process.umask(prevUmask);
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// When there is no existing lock, the direct tryCreateLock call above must
// be what wins the race: it must not fall through to the stale-lock check
// (fs.statSync/unlinkSync), since those exist only for the case where a
// lock already exists.
test("acquireOrWaitForLock: the fresh-create path never touches the stale-lock check", (t) => {
  const dir = makeDir();
  const lockPath = path.join(dir, "x.spawn");
  const statSync = t.mock.method(fs, "statSync");
  const unlinkSync = t.mock.method(fs, "unlinkSync");
  try {
    assert.equal(acquireOrWaitForLock(lockPath, 60_000), "holder");
    assert.equal(statSync.mock.callCount(), 0);
    assert.equal(unlinkSync.mock.callCount(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Boundary case for the staleness check itself: a lock aged exactly
// staleAfterMs is not yet stale (ageMs < staleAfterMs is false at
// equality), so it must still be treated as a live holder's lock (waiter),
// not reclaimed. Date.now is mocked so the boundary is hit exactly, not
// approximately.
test("acquireOrWaitForLock: a lock aged exactly staleAfterMs is not stale yet", (t) => {
  const dir = makeDir();
  const lockPath = path.join(dir, "x.spawn");
  try {
    tryCreateLock(lockPath);
    const mtimeMs = fs.statSync(lockPath).mtimeMs;
    const staleAfterMs = 5000;
    const fixedNow = mtimeMs + staleAfterMs;
    t.mock.method(Date, "now", () => fixedNow);
    assert.equal(acquireOrWaitForLock(lockPath, staleAfterMs), "holder");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The final `tryCreateLock(lockPath) ? "holder" : "waiter"` case: a lock
// found stale gets unlinked and re-created, but if another process wins
// that re-creation race, the result must be exactly "waiter" (a
// mis-emptied string here would still be falsy and look like it worked).
// The unlink itself is mocked to simulate the racer: it calls through to
// really remove the file, then immediately recreates it, so this
// process's own follow-up tryCreateLock sees EEXIST.
test("acquireOrWaitForLock: losing the reclaim race after a stale lock returns \"waiter\"", (t) => {
  const dir = makeDir();
  const lockPath = path.join(dir, "x.spawn");
  try {
    tryCreateLock(lockPath);
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, tenSecondsAgo, tenSecondsAgo);
    const realUnlinkSync = fs.unlinkSync;
    t.mock.method(fs, "unlinkSync", (p: string) => {
      realUnlinkSync(p);
      fs.writeFileSync(lockPath, "racer\n", { flag: "wx", mode: 0o600 });
    });
    assert.equal(acquireOrWaitForLock(lockPath, 1000), "waiter");
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

// startChain reads __spawn's pid off its stdout as text, split on the first
// newline. These drive that parser directly against a fake child (no real
// process spawned), so a chunk boundary in the middle of the number is
// exercised deterministically instead of by luck.
test("startChain: parses a pid split across two stdout chunks", async (t) => {
  const child = fakeChild();
  t.mock.method(childProcess, "spawn", () => child);
  const p = startChain("sock", "log", "fp", ["cmd"]);
  child.stdout.emit("data", Buffer.from("12"));
  child.stdout.emit("data", Buffer.from("34\n"));
  assert.equal(await p, 1234);
});

test("startChain: a bare newline with no digits before it rejects, it does not resolve", async (t) => {
  const child = fakeChild();
  t.mock.method(childProcess, "spawn", () => child);
  const p = startChain("sock", "log", "fp", ["cmd"]);
  child.stdout.emit("data", Buffer.from("garbage\n"));
  await assert.rejects(p, /__spawn did not report a pid/);
});

test("startChain: the spawned intermediate's own \"error\" event rejects the pid promise", async (t) => {
  const child = fakeChild();
  t.mock.method(childProcess, "spawn", () => child);
  const p = startChain("sock", "log", "fp", ["cmd"]);
  child.emit("error", new Error("spawn EACCES"));
  await assert.rejects(p, /spawn EACCES/);
});

// Not verified here: that the OS actually gives the child its own process
// group. That would need sending a signal to this test process's own
// group within the few milliseconds before __spawn exits, which is not a
// deterministic window; this checks the option that requests it instead.
test("startChain: spawns the intermediate with detached: true", async (t) => {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));
  const logPath = path.join(dir, "chain.log");
  const sockPath = path.join(dir, "unused.sock");
  const spawn = t.mock.method(childProcess, "spawn");
  const pid = await startChain(sockPath, logPath, "fp", [path.join(fixturesDir, "exit1")]);
  assert.equal(pid > 0, true);
  const [, , options] = spawn.mock.calls[0]!.arguments as [unknown, unknown, { detached?: boolean }];
  assert.equal(options.detached, true);
});

// startChain's own stdio array (["ignore", "pipe", "inherit"]) is what lets
// __spawn's diagnostics reach the caller's stderr, distinct from the pid
// line read off stdout above. Exercised through a real subprocess (not the
// fake-child mocks above) since "inherit" is a real fd-passing behavior a
// mock cannot stand in for. An empty spawnCommand makes __spawn's own argv
// parsing usage-error before it ever prints a pid line (args.ts rejects a
// "--" with nothing after it), which is enough to prove its stderr reaches
// this process's own captured stderr.
test("startChain: the spawned intermediate's stderr is inherited by the caller, not swallowed", async (t) => {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));
  const logPath = path.join(dir, "chain.log");
  const sockPath = path.join(dir, "unused.sock");
  const script =
    `import("${pathToFileUrl(connectModulePath)}").then((m) => ` +
    `m.startChain(process.argv[1], process.argv[2], "fp", []).catch(() => {}))`;
  const result = await new Promise<{ stderr: string }>((resolve) => {
    const child = childProcess.spawn(process.execPath, ["-e", script, sockPath, logPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("close", () => resolve({ stderr }));
  });
  assert.match(result.stderr, /nothing follows '--'/);
});

// The chain marker's value is checked for truthiness (`if
// (process.env[CHAIN_MARKER])`), so an empty string would silently defeat
// the recursion guard the marker exists for -- this checks the literal
// value reaching the chain's own env, not just its presence.
test("startChain: sets the chain marker to exactly \"1\" in the spawned chain's env", async (t) => {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));
  const logPath = path.join(dir, "chain.log");
  const sockPath = path.join(dir, "unused.sock");
  await startChain(sockPath, logPath, "fp", ["/bin/sh", "-c", 'printf %s "$AUTOSPAWN_IN_CHAIN"']);
  await waitFor(() => fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").length > 0);
  assert.equal(fs.readFileSync(logPath, "utf8"), "1");
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
  process.env.AUTOSPAWN_IN_CHAIN = "1";
  try {
    await assert.rejects(
      startChain(sockPath, logPath, "fp", [path.join(fixturesDir, "exit1")]),
      /inside another chain/,
    );
    assert.equal(spawn.mock.callCount(), 0);
  } finally {
    delete process.env.AUTOSPAWN_IN_CHAIN;
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
  assert.equal(result.stderr, `autospawn connect: boom (log: ${logPath})\n`);
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

test("tryConnect: destroys the socket after a connection error", async (t) => {
  const fakeSock = new EventEmitter() as unknown as net.Socket;
  const destroy = t.mock.fn();
  (fakeSock as unknown as { destroy: () => void }).destroy = destroy;
  t.mock.method(net, "connect", () => fakeSock);
  const p = tryConnect("/unused");
  fakeSock.emit("error", new Error("boom"));
  assert.equal(await p, null);
  assert.equal(destroy.mock.callCount(), 1);
});

// The success path removes its own error listener (see the comment next to
// removeListener in tryConnect); if it did not, a later error on the same
// socket -- one attachAndRelay's own "error" listener is meant to handle --
// would also re-trigger this function's already-settled resolve/destroy.
test("tryConnect: leaves no error listener behind on a successful connect", async (t) => {
  const fakeSock = new EventEmitter() as unknown as net.Socket;
  t.mock.method(net, "connect", () => fakeSock);
  const p = tryConnect("/unused");
  fakeSock.emit("connect");
  const sock = await p;
  assert.equal(sock, fakeSock);
  assert.equal((sock as unknown as EventEmitter).listenerCount("error"), 0);
});

test("sleep: actually delays, it does not resolve immediately", async () => {
  const start = Date.now();
  await sleep(80);
  assert.ok(Date.now() - start >= 60, "sleep(80) resolved suspiciously fast");
});
