// serve started directly, without connect, so each test controls the
// resident's idle timeout, its log, and the connections it holds. Every
// serve a test starts is killed in that test's cleanup, since a mutated
// serve may never exit on its own.
import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { sameOwnership, statOwnership } from "../src/serve.ts";
import {
  attachRaw,
  exitWithin,
  fixturesDir,
  isDead,
  makeStateDir,
  removeStateDir,
  runCli,
  sleep,
  startServeDirect,
  waitFor,
} from "./helpers.ts";

const FINGERPRINT = "serve-test-fingerprint";

function killOnCleanup(t: TestContext, child: ChildProcess): void {
  t.after(() => {
    if (!isDead(child.pid!)) child.kill("SIGKILL");
  });
}

function stateDir(t: TestContext): string {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));
  return dir;
}

// Linux can give a new file the inode number of one just removed, so a
// replaced socket can match on device and inode. The change time is what
// tells them apart.
test("ownership: a file with the same device and inode but another change time is not the same", () => {
  const owned = { dev: 1n, ino: 2n, ctimeNs: 3n };
  assert.equal(sameOwnership(owned, { dev: 1n, ino: 2n, ctimeNs: 3n }), true);
  assert.equal(sameOwnership(owned, { dev: 1n, ino: 2n, ctimeNs: 4n }), false);
  assert.equal(sameOwnership(owned, { dev: 1n, ino: 9n, ctimeNs: 3n }), false);
  assert.equal(sameOwnership(owned, null), false);
});

// The cost of checking the change time: a chmod on the path after serve
// recorded it counts as a replacement. serve records it after its own
// chmod for that reason.
test("ownership: a chmod after the record counts as a change", async (t) => {
  const dir = stateDir(t);
  const file = path.join(dir, "probe");
  fs.writeFileSync(file, "");
  const before = statOwnership(file);
  assert.ok(before);
  assert.equal(sameOwnership(before, statOwnership(file)), true);
  await sleep(10);
  fs.chmodSync(file, 0o600);
  assert.equal(sameOwnership(before, statOwnership(file)), false);
  assert.equal(statOwnership(path.join(dir, "missing")), null);
});

test("serve without AUTOSPAWN_FINGERPRINT explains and exits 2", async (t) => {
  const dir = stateDir(t);
  const env: NodeJS.ProcessEnv = { ...process.env, AUTOSPAWN_SOCKET: path.join(dir, "nofp.sock") };
  delete env.AUTOSPAWN_FINGERPRINT;
  const result = await runCli(["serve", "--", path.join(fixturesDir, "echo-server")], { env });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /AUTOSPAWN_FINGERPRINT is not set/);
});

test("serve refuses a state directory that group or other can open", async (t) => {
  const dir = stateDir(t);
  fs.chmodSync(dir, 0o755);
  const serve = startServeDirect(path.join(dir, "open.sock"), FINGERPRINT);
  killOnCleanup(t, serve);
  assert.deepEqual(await exitWithin(serve, 5000), { code: 1, signal: null });
  assert.equal(fs.existsSync(path.join(dir, "open.sock")), false);
});

test("serve without --idle-timeout keeps running with no connections", async (t) => {
  const dir = stateDir(t);
  const serve = startServeDirect(path.join(dir, "forever.sock"), FINGERPRINT, "echo-server", null);
  killOnCleanup(t, serve);
  await waitFor(() => fs.existsSync(path.join(dir, "forever.sock")), { timeoutMs: 5000 });
  assert.equal(await exitWithin(serve, 2500), "still running");
});

test("one connection closing does not start the idle timeout while another is open", async (t) => {
  const dir = stateDir(t);
  const sockPath = path.join(dir, "two.sock");
  const serve = startServeDirect(sockPath, FINGERPRINT, "echo-server", 1);
  killOnCleanup(t, serve);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });

  const first = await attachRaw(sockPath, FINGERPRINT);
  const second = await attachRaw(sockPath, FINGERPRINT);
  first.end();
  assert.equal(await exitWithin(serve, 2500), "still running");

  second.end();
  assert.deepEqual(await exitWithin(serve, 5000), { code: 0, signal: null });
});

// A client that connects just before the idle timeout, and is still
// sending its header when the timer would fire, must get its child and
// keep the resident alive. Closing the server at that point would remove
// the socket file, so the next client would start a new resident.
test("a connection still sending its header holds off the idle timeout", async (t) => {
  const dir = stateDir(t);
  const sockPath = path.join(dir, "slowheader.sock");
  const serve = startServeDirect(sockPath, FINGERPRINT, "echo-server", 1);
  killOnCleanup(t, serve);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });

  const sock = net.connect(sockPath);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  // Past the 1s idle timeout, and still inside the 5s header timeout.
  await sleep(1800);
  assert.equal(fs.existsSync(sockPath), true, "the resident must still own its socket");
  sock.end();

  // With nothing left, the idle timeout runs again and ends the resident.
  assert.deepEqual(await exitWithin(serve, 5000), { code: 0, signal: null });
});

test("stop with a client attached ends the child and the resident at once", async (t) => {
  const dir = stateDir(t);
  const sockPath = path.join(dir, "busy.sock");
  // A long idle timeout, so only stop can end it within the test.
  const serve = startServeDirect(sockPath, FINGERPRINT, "echo-server", 60);
  killOnCleanup(t, serve);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });

  const client = await attachRaw(sockPath, FINGERPRINT);
  const clientClosed = new Promise<void>((resolve) => client.once("close", () => resolve()));

  const stop = await runCli(["stop", "--name", "busy"], {
    env: { ...process.env, AUTOSPAWN_DIR: dir },
  });
  assert.equal(stop.code, 0, stop.stderr);
  assert.deepEqual(await exitWithin(serve, 5000), { code: 0, signal: null });
  await clientClosed;
});

test("a serve that loses its socket logs the loss once, however long it drains", async (t) => {
  const dir = stateDir(t);
  const sockPath = path.join(dir, "lost.sock");
  const logPath = path.join(dir, "lost-serve.log");
  const logFd = fs.openSync(logPath, "a");
  t.after(() => fs.closeSync(logFd));

  const serveA = startServeDirect(sockPath, FINGERPRINT, "echo-server", 60, { stderrFd: logFd });
  killOnCleanup(t, serveA);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });
  const client = await attachRaw(sockPath, FINGERPRINT);

  fs.unlinkSync(sockPath);
  const serveB = startServeDirect(sockPath, FINGERPRINT, "echo-server", 60);
  killOnCleanup(t, serveB);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });

  // Several ownership checks run while the client keeps serveA draining.
  await sleep(3500);
  const lossLines = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.includes("lost ownership of the socket path"));
  assert.equal(lossLines.length, 1);

  client.end();
  assert.deepEqual(await exitWithin(serveA, 5000), { code: 0, signal: null });
  assert.equal(fs.existsSync(sockPath), true, "serveA must leave serveB's socket in place");
});
