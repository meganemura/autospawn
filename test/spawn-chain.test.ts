// runSpawnChain is only ever invoked through the hidden `__spawn` CLI
// subcommand, itself only ever invoked by connect.ts's own detached
// double-fork chain -- every existing test reaches it, if at all, through
// two layers of subprocess. It has no process.exit calls and does its own
// child-process spawn directly, so it is easy to call in-process here,
// with node:test's built-in mocking standing in for the real spawn and for
// fs.closeSync, whose call is otherwise unobservable from outside.
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { runSpawnChain } from "../src/spawn-chain.ts";

function makeLogPath(): { dir: string; logPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mas-spawnchain-"));
  return { dir, logPath: path.join(dir, "test.log") };
}

test("runSpawnChain: an empty command writes to stderr and sets exitCode 2, without spawning", (t) => {
  const spawnMock = t.mock.method(childProcess, "spawn");
  const stderrWrites: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string) => {
    stderrWrites.push(chunk);
    return true;
  });
  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    runSpawnChain("/dev/null", []);
    assert.equal(process.exitCode, 2);
    assert.equal(spawnMock.mock.callCount(), 0);
    assert.match(stderrWrites.join(""), /empty command/);
  } finally {
    process.exitCode = savedExitCode;
  }
});

test("runSpawnChain: spawns the command detached, with stdio pointed at the log fd, and closes the fd afterward", (t) => {
  const { dir, logPath } = makeLogPath();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fakeChild = { pid: 424242, unref: () => {} };
  const spawnMock = t.mock.method(childProcess, "spawn", () => fakeChild as never);
  const closeSyncMock = t.mock.method(fs, "closeSync");
  const stdoutWrites: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string) => {
    stdoutWrites.push(chunk);
    return true;
  });
  t.mock.method(process.stdout, "on", () => process.stdout); // avoid a real "error" listener leak

  runSpawnChain(logPath, ["some-command", "--arg"]);

  assert.equal(spawnMock.mock.callCount(), 1);
  const call = spawnMock.mock.calls[0]!;
  assert.equal(call.arguments[0], "some-command");
  assert.deepEqual(call.arguments[1], ["--arg"]);
  const options = call.arguments[2] as { detached?: boolean; stdio?: unknown[] };
  assert.equal(options.detached, true);
  assert.equal((options.stdio as unknown[])[0], "ignore");
  const usedFd = (options.stdio as number[])[1];
  assert.equal((options.stdio as number[])[2], usedFd);

  // closeSync must run, and with the same fd spawn was given -- this is
  // what a mutant removing the finally block, or just the closeSync call,
  // cannot fake past.
  assert.equal(closeSyncMock.mock.callCount(), 1);
  assert.equal(closeSyncMock.mock.calls[0]!.arguments[0], usedFd);

  assert.equal(stdoutWrites.join(""), "424242\n");
});

test("runSpawnChain: closes the log fd even if spawn throws", (t) => {
  const { dir, logPath } = makeLogPath();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  t.mock.method(childProcess, "spawn", () => {
    throw new Error("synthetic spawn failure");
  });
  const closeSyncMock = t.mock.method(fs, "closeSync");

  assert.throws(() => runSpawnChain(logPath, ["cmd"]), /synthetic spawn failure/);
  assert.equal(closeSyncMock.mock.callCount(), 1);
});

test("runSpawnChain: a broken stdout pipe does not crash the process", (t) => {
  const { dir, logPath } = makeLogPath();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const fakeChild = { pid: 1, unref: () => {} };
  t.mock.method(childProcess, "spawn", () => fakeChild as never);
  const onMock = t.mock.method(process.stdout, "on", () => process.stdout);
  t.mock.method(process.stdout, "write", () => true);

  runSpawnChain(logPath, ["cmd"]);

  // An "error" listener must be attached before the write, so a broken
  // pipe (EPIPE, if connect is already gone) is caught instead of thrown.
  const errorListenerCalls = onMock.mock.calls.filter(
    (c) => (c.arguments[0] as string) === "error",
  );
  assert.equal(errorListenerCalls.length, 1);
});
