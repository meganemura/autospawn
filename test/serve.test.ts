// serve started directly, without connect, so each test controls the
// resident's idle timeout, its log, and the connections it holds. Every
// serve a test starts is killed in that test's cleanup, since a mutated
// serve may never exit on its own.
import { type ChildProcess, spawn } from "node:child_process";
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

// Raw socket helpers for the header tests below: they talk to serve
// without the attach helper, so a test can send a header serve refuses.
async function openRaw(sockPath: string): Promise<net.Socket> {
  const sock = net.connect(sockPath);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  return sock;
}

// Collects everything the socket sends until it closes, or until
// timeoutMs passes.
function readUntilClose(sock: net.Socket, timeoutMs: number): Promise<string | "still open"> {
  return new Promise((resolve) => {
    let buf = "";
    const timer = setTimeout(() => resolve("still open"), timeoutMs);
    sock.on("data", (chunk: Buffer) => (buf += chunk.toString("utf8")));
    sock.once("close", () => {
      clearTimeout(timer);
      resolve(buf);
    });
  });
}

async function startedServe(
  t: TestContext,
  name: string,
  server = "echo-server",
  opts: { stderrFd?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ serve: ChildProcess; sockPath: string; dir: string }> {
  const dir = stateDir(t);
  const sockPath = path.join(dir, `${name}.sock`);
  const serve = startServeDirect(sockPath, FINGERPRINT, server, 60, opts);
  killOnCleanup(t, serve);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });
  return { serve, sockPath, dir };
}

test("a header that is not JSON gets its connection closed without a reply", async (t) => {
  const { sockPath } = await startedServe(t, "notjson");
  const sock = await openRaw(sockPath);
  sock.write("not json\n");
  assert.equal(await readUntilClose(sock, 3000), "");
});

test("JSON that is neither attach nor stop gets a bad_header reply, then a close", async (t) => {
  const { sockPath } = await startedServe(t, "badheader");
  const sock = await openRaw(sockPath);
  sock.write(JSON.stringify({ v: 1, op: "hello" }) + "\n");
  assert.equal(
    await readUntilClose(sock, 3000),
    '{"ok":false,"error":"bad_header","message":"expected attach or stop"}\n',
  );
});

test("an attach with another fingerprint gets a fingerprint_mismatch reply, then a close", async (t) => {
  const { sockPath } = await startedServe(t, "mismatch");
  const sock = await openRaw(sockPath);
  sock.write(JSON.stringify({ v: 1, op: "attach", fingerprint: "other" }) + "\n");
  assert.equal(
    await readUntilClose(sock, 3000),
    '{"ok":false,"error":"fingerprint_mismatch","message":"spawn command does not match"}\n',
  );
});

test("a server command that cannot start is logged, and its connection closes", async (t) => {
  const dir = stateDir(t);
  const logPath = path.join(dir, "missing-serve.log");
  const logFd = fs.openSync(logPath, "a");
  t.after(() => fs.closeSync(logFd));
  const { sockPath } = await startedServe(t, "missing", "no-such-server", { stderrFd: logFd });

  const client = await attachRaw(sockPath, FINGERPRINT);
  assert.notEqual(await readUntilClose(client, 3000), "still open");
  await waitFor(() => /\[serve\] server-command error: .*ENOENT/.test(fs.readFileSync(logPath, "utf8")), {
    timeoutMs: 3000,
  });
});

test("the server child's stderr reaches serve's log", async (t) => {
  const dir = stateDir(t);
  const logPath = path.join(dir, "childerr-serve.log");
  const logFd = fs.openSync(logPath, "a");
  t.after(() => fs.closeSync(logFd));
  const { sockPath } = await startedServe(t, "childerr", "echo-server-stderr", { stderrFd: logFd });

  const client = await attachRaw(sockPath, FINGERPRINT);
  await waitFor(() => fs.readFileSync(logPath, "utf8").includes("stderr from the server child"), {
    timeoutMs: 3000,
  });
  client.end();
});

// Writes that reach a child which already exited fail with EPIPE on its
// stdin. serve must absorb that, and keep serving.
test("a client that keeps writing to a child that exited does not bring serve down", async (t) => {
  const { serve, sockPath } = await startedServe(t, "epipe", "exit1");
  const client = await attachRaw(sockPath, FINGERPRINT);
  client.on("error", () => {});
  const payload = Buffer.alloc(64 * 1024, 0x61);
  for (let i = 0; i < 20; i += 1) {
    if (client.destroyed) break;
    client.write(payload);
    await sleep(20);
  }
  assert.equal(await exitWithin(serve, 1000), "still running");
  const second = await attachRaw(sockPath, FINGERPRINT);
  second.destroy();
});

test("a client that disconnects gets its child stopped once the child writes, even if it ignores stdin", async (t) => {
  const dir = stateDir(t);
  const pidFile = path.join(dir, "child.pid");
  const { serve, sockPath } = await startedServe(t, "ticker", "pid-ticker", {
    env: { TEST_PIDFILE: pidFile },
  });

  const client = await attachRaw(sockPath, FINGERPRINT);
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "", {
    timeoutMs: 3000,
  });
  const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  t.after(() => {
    if (!isDead(childPid)) process.kill(childPid, "SIGKILL");
  });

  client.destroy();
  await waitFor(() => isDead(childPid), { timeoutMs: 3000 });
  // The failed write must not take serve down with it. If serve crashed,
  // the child would die too, from SIGPIPE, so its death alone proves
  // nothing about serve.
  assert.equal(await exitWithin(serve, 1000), "still running");
});

test("a serve that lost its socket waits for its last child, not its first, before it exits", async (t) => {
  const { serve, sockPath } = await startedServe(t, "twochildren");
  const first = await attachRaw(sockPath, FINGERPRINT);
  const second = await attachRaw(sockPath, FINGERPRINT);

  fs.unlinkSync(sockPath);
  const serveB = startServeDirect(sockPath, FINGERPRINT, "echo-server", 60);
  killOnCleanup(t, serveB);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });
  await sleep(1500);

  first.end();
  assert.equal(await exitWithin(serve, 1500), "still running");
  second.end();
  assert.deepEqual(await exitWithin(serve, 5000), { code: 0, signal: null });
});

test("serve makes its socket readable and writable by its owner only", async (t) => {
  const { sockPath } = await startedServe(t, "mode");
  assert.equal(fs.statSync(sockPath).mode & 0o777, 0o600);
});

test("with no connection at all, the idle timeout still ends serve", async (t) => {
  const dir = stateDir(t);
  const serve = startServeDirect(path.join(dir, "neverused.sock"), FINGERPRINT, "echo-server", 1);
  killOnCleanup(t, serve);
  assert.deepEqual(await exitWithin(serve, 5000), { code: 0, signal: null });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} makes serve remove its socket and exit 0`, async (t) => {
    const { serve, sockPath } = await startedServe(t, `sig-${signal.toLowerCase()}`);
    serve.kill(signal);
    assert.deepEqual(await exitWithin(serve, 5000), { code: 0, signal: null });
    assert.equal(fs.existsSync(sockPath), false);
  });
}

test("SIGTERM to a serve that lost its socket leaves the new resident's socket alone", async (t) => {
  const { serve: serveA, sockPath } = await startedServe(t, "sigafterloss");
  // A client attached to serveA keeps it draining after the loss, so only
  // the signal can end it.
  const client = await attachRaw(sockPath, FINGERPRINT);
  client.on("error", () => {});
  fs.unlinkSync(sockPath);
  const serveB = startServeDirect(sockPath, FINGERPRINT, "echo-server", 60);
  killOnCleanup(t, serveB);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });
  const inodeB = fs.statSync(sockPath).ino;
  await sleep(1500);
  assert.equal(await exitWithin(serveA, 100), "still running");

  serveA.kill("SIGTERM");
  assert.deepEqual(await exitWithin(serveA, 5000), { code: 0, signal: null });
  assert.equal(fs.existsSync(sockPath), true, "serveB's socket must survive");
  assert.equal(fs.statSync(sockPath).ino, inodeB);
});

test("a second serve on a path where one already listens logs it and steps aside", async (t) => {
  const { sockPath, dir } = await startedServe(t, "occupied");
  const logPath = path.join(dir, "second-serve.log");
  const logFd = fs.openSync(logPath, "a");
  t.after(() => fs.closeSync(logFd));

  const second = startServeDirect(sockPath, FINGERPRINT, "echo-server", 60, { stderrFd: logFd });
  killOnCleanup(t, second);
  assert.deepEqual(await exitWithin(second, 5000), { code: 0, signal: null });
  assert.match(fs.readFileSync(logPath, "utf8"), /\[serve\] another resident is already listening; exiting/);

  const client = await attachRaw(sockPath, FINGERPRINT);
  client.destroy();
});

// A stale socket that serve cannot remove must not make it retry forever.
test("a stale socket in a directory serve cannot write ends serve with an error", async (t) => {
  const dir = stateDir(t);
  const sockPath = path.join(dir, "stuck.sock");
  const holder = spawn(process.execPath, ["-e", 'require("node:net").createServer().listen(process.argv[1])', sockPath], {
    stdio: "ignore",
  });
  killOnCleanup(t, holder);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });
  holder.kill("SIGKILL");
  await waitFor(() => isDead(holder.pid!), { timeoutMs: 5000 });
  assert.equal(fs.existsSync(sockPath), true, "the killed listener leaves its socket file behind");

  fs.chmodSync(dir, 0o500);
  try {
    const serve = startServeDirect(sockPath, FINGERPRINT, "echo-server", 60);
    killOnCleanup(t, serve);
    assert.deepEqual(await exitWithin(serve, 5000), { code: 1, signal: null });
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test("a child closing while another connection is still being set up does not start the idle timeout", async (t) => {
  const sockPath = path.join(stateDir(t), "overlap.sock");
  const short = startServeDirect(sockPath, FINGERPRINT, "echo-server", 1);
  killOnCleanup(t, short);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });

  const pendingClient = await openRaw(sockPath);
  const attached = await attachRaw(sockPath, FINGERPRINT);
  const attachedClosed = new Promise<void>((resolve) => attached.once("close", () => resolve()));
  attached.end();
  await attachedClosed;

  // Past the 1s idle timeout, with pendingClient still sending no header.
  await sleep(1800);
  assert.equal(fs.existsSync(sockPath), true, "the resident must still own its socket");

  pendingClient.end();
  assert.deepEqual(await exitWithin(short, 5000), { code: 0, signal: null });
});

test("a directory serve cannot write, with no stale socket in it, ends serve with an error", async (t) => {
  const dir = stateDir(t);
  fs.chmodSync(dir, 0o500);
  try {
    const serve = startServeDirect(path.join(dir, "nowrite.sock"), FINGERPRINT, "echo-server", 60);
    killOnCleanup(t, serve);
    assert.deepEqual(await exitWithin(serve, 5000), { code: 1, signal: null });
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});
