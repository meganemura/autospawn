import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  baseEnv,
  cliPath,
  fixturesDir,
  isDead,
  makeStateDir,
  removeStateDir,
  runCli,
  spawnConnect,
  startServeDirect,
  waitFor,
  isListening,
  waitForListening,
} from "./helpers.ts";
import { encodeLine } from "../src/protocol.ts";

function chainArgs(): string[] {
  return [
    path.join(fixturesDir, "slow-wrapper"),
    process.execPath,
    cliPath,
    "serve",
    "--idle-timeout",
    "10",
    "--",
    path.join(fixturesDir, "echo-server"),
  ];
}

function pkillChildrenOf(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile("pkill", ["-P", String(pid)], () => resolve()); // exit 1 when nothing matched is fine
  });
}

test("killing connect mid-startup does not kill the resident chain", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const sockPath = path.join(dir, "resilient12.sock");
  const countFile = path.join(dir, "count");
  const pidFile = path.join(dir, "slow.pid");
  t.after(() => {
    void runCli(["stop", "--name", "resilient12"], { env });
    removeStateDir(dir);
  });

  const connect = spawnConnect(
    ["--name", "resilient12", "--timeout", "30", "--", ...chainArgs()],
    {
      ...env,
      FAKE_WRAPPER_COUNT_FILE: countFile,
      SLOW_WRAPPER_PID_FILE: pidFile,
      SLOW_WRAPPER_SLEEP: "1",
    },
  );

  await waitFor(() => fs.existsSync(pidFile), { timeoutMs: 5000 });
  connect.kill("SIGKILL");

  await waitForListening(sockPath);
  assert.equal(fs.readFileSync(countFile, "utf8").length, 1);

  const second = await runCli(["connect", "--name", "resilient12", "--", ...chainArgs()], {
    env: { ...env, FAKE_WRAPPER_COUNT_FILE: countFile, SLOW_WRAPPER_PID_FILE: pidFile },
    input: "hi\n",
  });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, "hi\n");
  assert.equal(
    fs.readFileSync(countFile, "utf8").length,
    1,
    "attaching to the survivor must not spawn a second chain",
  );
});

test("pkill -P <connect pid> during startup does not reach the resident chain", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const sockPath = path.join(dir, "resilient13.sock");
  const countFile = path.join(dir, "count");
  const pidFile = path.join(dir, "slow.pid");
  t.after(() => {
    void runCli(["stop", "--name", "resilient13"], { env });
    removeStateDir(dir);
  });

  const connect = spawnConnect(
    ["--name", "resilient13", "--timeout", "30", "--", ...chainArgs()],
    {
      ...env,
      FAKE_WRAPPER_COUNT_FILE: countFile,
      SLOW_WRAPPER_PID_FILE: pidFile,
      SLOW_WRAPPER_SLEEP: "1",
    },
  );

  await waitFor(() => fs.existsSync(pidFile), { timeoutMs: 5000 });
  if (connect.pid) await pkillChildrenOf(connect.pid);
  connect.kill("SIGKILL");

  await waitForListening(sockPath);
  assert.equal(fs.readFileSync(countFile, "utf8").length, 1);
});

// The other ownership tests replace the path with a live socket, where a
// comparison that skips the "path is gone" case still gives the right
// answer. Here nothing replaces it, so the check sees no file at all, and
// serve must treat that as a lost race and exit cleanly, not crash.
test("a serve whose socket path is removed, with nothing in its place, exits 0", async (t) => {
  const dir = makeStateDir();
  const sockPath = path.join(dir, "vanished.sock");
  t.after(() => removeStateDir(dir));

  // A long idle timeout, so only the ownership check can end it in time.
  const serve = startServeDirect(sockPath, "test-fingerprint", "echo-server", 60);
  t.after(() => {
    if (!isDead(serve.pid!)) serve.kill("SIGKILL");
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    serve.once("exit", (code, signal) => resolve({ code, signal })),
  );
  await waitForListening(sockPath);

  fs.unlinkSync(sockPath);

  const result = await Promise.race([
    exited,
    new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 5000)),
  ]);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(fs.existsSync(sockPath), false, "serve must not recreate the path");
});

test("a serve that loses the ownership race steps aside without deleting the winner's socket", async (t) => {
  const dir = makeStateDir();
  const sockPath = path.join(dir, "race14.sock");
  const fingerprint = "test-fingerprint";
  t.after(() => removeStateDir(dir));

  const serveA = startServeDirect(sockPath, fingerprint);
  await waitForListening(sockPath);
  const inodeA = fs.statSync(sockPath).ino;

  // Simulate a lost race: another starter removes the path out from under
  // serveA, and a second resident binds the fresh file.
  fs.unlinkSync(sockPath);
  const serveB = startServeDirect(sockPath, fingerprint);
  await waitFor(() => isListening(sockPath) && fs.statSync(sockPath).ino !== inodeA, {
    timeoutMs: 5000,
  });

  // serveA has zero connections, so its 1s ownership check should notice
  // and exit on its own, without touching serveB's socket.
  await waitFor(() => isDead(serveA.pid!), { timeoutMs: 5000 });

  assert.equal(fs.existsSync(sockPath), true, "the winner's socket must survive");

  // serveB must still be answering.
  const sock = net.connect(sockPath);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  sock.destroy();

  serveB.kill("SIGTERM");
});

test("a serve with an active child still exits once it loses the ownership race", async (t) => {
  const dir = makeStateDir();
  const sockPath = path.join(dir, "race-active.sock");
  const fingerprint = "test-fingerprint-active";
  t.after(() => removeStateDir(dir));

  const serveA = startServeDirect(sockPath, fingerprint);
  await waitForListening(sockPath);
  const inodeA = fs.statSync(sockPath).ino;

  // Attach one live connection to serveA, so it has an active child
  // (children.size > 0) when it loses ownership below. Before this was
  // fixed, checkOwnership returned early once raceLost was set, and the child's
  // "close" handler only called scheduleIdleCheck, so an orphan with no
  // remaining children never exited on its own.
  const client = net.connect(sockPath);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  client.write(encodeLine({ v: 1, op: "attach", fingerprint }));
  await new Promise<void>((resolve) => {
    client.once("data", () => resolve());
  });

  fs.unlinkSync(sockPath);
  const serveB = startServeDirect(sockPath, fingerprint);
  await waitFor(() => isListening(sockPath) && fs.statSync(sockPath).ino !== inodeA, {
    timeoutMs: 5000,
  });

  // Give serveA's 1-second ownership check a chance to notice the loss
  // while the connection above is still open (children.size > 0).
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(isDead(serveA.pid!), false, "serveA should still be draining, not dead yet");

  // Now end the one connection it has left; this must make serveA exit.
  client.end();

  await waitFor(() => isDead(serveA.pid!), { timeoutMs: 5000 });
  assert.equal(fs.existsSync(sockPath), true, "the winner's socket must survive");

  serveB.kill("SIGTERM");
});
