import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { encodeLine, readHeaderLine } from "../src/protocol.ts";
import { baseEnv, cliPath, fixturesDir, makeStateDir, removeStateDir, runCli, waitFor } from "./helpers.ts";

// A default --idle-timeout, so a resident this file's own `stop` calls
// don't reach (a test killed mid-run under mutation testing, for example)
// exits on its own instead of running forever.
const DEFAULT_SERVE_ARGS = ["--idle-timeout", "10"];

function chainArgs(server = "echo-server", serveArgs: string[] = DEFAULT_SERVE_ARGS): string[] {
  return [
    path.join(fixturesDir, "fake-wrapper"),
    process.execPath,
    cliPath,
    "serve",
    ...serveArgs,
    "--",
    path.join(fixturesDir, server),
  ];
}

test("stop ends the resident and removes the socket; a second stop says not running", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const sockPath = path.join(dir, "stoppable.sock");
  t.after(() => removeStateDir(dir));

  const connectResult = await runCli(
    ["connect", "--name", "stoppable", "--", ...chainArgs()],
    { env, input: "hi\n" },
  );
  assert.equal(connectResult.code, 0, connectResult.stderr);
  assert.equal(fs.existsSync(sockPath), true);

  const stopResult = await runCli(["stop", "--name", "stoppable"], { env });
  assert.equal(stopResult.code, 0);
  assert.match(stopResult.stderr, /stopped/);
  await waitFor(() => !fs.existsSync(sockPath));

  const secondStop = await runCli(["stop", "--name", "stoppable"], { env });
  assert.equal(secondStop.code, 0);
  assert.match(secondStop.stderr, /not running/);
});

test("--idle-timeout ends the resident once connections drop to zero", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const sockPath = path.join(dir, "idlecheck.sock");
  t.after(() => {
    void runCli(["stop", "--name", "idlecheck"], { env });
    removeStateDir(dir);
  });

  const connectResult = await runCli(
    ["connect", "--name", "idlecheck", "--", ...chainArgs("echo-server", ["--idle-timeout", "1"])],
    { env, input: "hi\n" },
  );
  assert.equal(connectResult.code, 0, connectResult.stderr);
  assert.equal(fs.existsSync(sockPath), true, "resident should still be up right after connect exits");

  await waitFor(() => !fs.existsSync(sockPath), { timeoutMs: 5000 });
});

test("serve writes its own diagnostics to the chain's log, marked [serve] and timestamped", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const sockPath = path.join(dir, "servelog.sock");
  const logPath = path.join(dir, "servelog.log");
  t.after(() => {
    void runCli(["stop", "--name", "servelog"], { env });
    removeStateDir(dir);
  });

  const connectResult = await runCli(
    ["connect", "--name", "servelog", "--", ...chainArgs("echo-server", ["--idle-timeout", "1"])],
    { env, input: "hi\n" },
  );
  assert.equal(connectResult.code, 0, connectResult.stderr);
  await waitFor(() => !fs.existsSync(sockPath), { timeoutMs: 5000 });

  // serve never opens the log itself: its stderr is the chain's log file,
  // so its own lines have to arrive there through that descriptor.
  assert.match(
    fs.readFileSync(logPath, "utf8"),
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[serve\] idle for 1s, stopping$/m,
  );
});

test("serve run directly, without AUTOSPAWN_SOCKET, explains and exits 2", async () => {
  const env = { ...process.env };
  delete env.AUTOSPAWN_SOCKET;
  const result = await runCli(["serve", "--", path.join(fixturesDir, "echo-server")], { env });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /AUTOSPAWN_SOCKET is not set/);
  assert.match(result.stderr, /started by 'autospawn connect', not run directly/);
});

test("stop: an error reply from the resident is printed and exits 1", async (t) => {
  // A fake resident (not the real serve.ts) that replies with an error to
  // any "stop" request, so this exercises stop.ts's own error-reply
  // branch without depending on serve.ts ever actually taking it (it
  // currently never does: serve always answers a stop with {ok:true}).
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const sockPath = path.join(dir, "erroring.sock");
  const server = net.createServer((socket) => {
    readHeaderLine(socket)
      .then(() => {
        socket.write(
          encodeLine({ ok: false, error: "test_error", message: "custom stop failure" }),
        );
      })
      .catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  t.after(() => {
    server.close();
    removeStateDir(dir);
  });

  const result = await runCli(["stop", "--name", "erroring"], { env });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /custom stop failure/);
});

test("stop: a residual socket file with nobody listening is removed, and reported as not running", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const sockPath = path.join(dir, "residual.sock");
  t.after(() => removeStateDir(dir));

  // Same construction as failures.test.ts's "stale socket" test: a real
  // listener, SIGKILLed, so the socket file survives with nothing behind
  // it (an orphan from a crashed resident) -- stop connecting to it gets
  // ECONNREFUSED, not ENOENT.
  const orphan = spawn(
    process.execPath,
    ["-e", `require("node:net").createServer().listen(process.argv[1])`, sockPath],
    { stdio: "ignore" },
  );
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (fs.existsSync(sockPath)) {
        clearInterval(check);
        resolve();
      }
    }, 20);
  });
  orphan.kill("SIGKILL");
  await new Promise<void>((resolve) => orphan.once("exit", () => resolve()));

  const result = await runCli(["stop", "--name", "residual"], { env });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /not running/);
  assert.equal(fs.existsSync(sockPath), false, "the residual socket file must be removed");
});
