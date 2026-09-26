import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  baseEnv,
  cliPath,
  fixturesDir,
  makeStateDir,
  removeStateDir,
  runCli,
} from "./helpers.ts";

function chainArgs(server = "echo-server"): string[] {
  return [
    path.join(fixturesDir, "fake-wrapper"),
    process.execPath,
    cliPath,
    "serve",
    "--",
    path.join(fixturesDir, server),
  ];
}

test("fingerprint mismatch: connect fails fast with stop guidance", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  t.after(() => {
    void runCli(["stop", "--name", "mismatch"], { env });
    removeStateDir(dir);
  });

  const first = await runCli(["connect", "--name", "mismatch", "--", ...chainArgs()], {
    env,
    input: "hi\n",
  });
  assert.equal(first.code, 0, first.stderr);

  // Same name, a different spawn-command argv (extra literal argument), so
  // the fingerprint no longer matches the resident already running.
  const second = await runCli(
    ["connect", "--name", "mismatch", "--", ...chainArgs(), "--extra-arg"],
    { env, input: "hi\n" },
  );
  assert.equal(second.code, 1);
  assert.match(second.stderr, /stop --name/);
});

test("a stale socket file with nobody listening does not block startup", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const sockPath = path.join(dir, "stale.sock");
  t.after(() => {
    void runCli(["stop", "--name", "stale"], { env });
    removeStateDir(dir);
  });

  // Listen on the path in a separate process, then SIGKILL it. Killing
  // instead of closing leaves the socket file on disk (net.Server.close()
  // unlinks its own path; a kill -9 runs no JS cleanup at all), which is
  // what an orphaned socket from a crashed resident looks like.
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
  assert.equal(fs.existsSync(sockPath), true);

  const result = await runCli(["connect", "--name", "stale", "--", ...chainArgs()], {
    env,
    input: "hi\n",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "hi\n");
});

test("spawn-command exiting nonzero fails connect fast, without waiting for --timeout", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  t.after(() => removeStateDir(dir));

  const start = Date.now();
  const result = await runCli(
    ["connect", "--name", "exit1test", "--timeout", "30", "--", path.join(fixturesDir, "exit1")],
    { env },
  );
  const elapsedMs = Date.now() - start;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /log:/);
  assert.ok(elapsedMs < 5000, `expected fast failure, took ${elapsedMs}ms`);
});

test("an open-permission base directory makes connect refuse to run", async (t) => {
  const dir = makeStateDir();
  fs.chmodSync(dir, 0o755);
  const env = baseEnv(dir);
  t.after(() => {
    fs.chmodSync(dir, 0o700);
    removeStateDir(dir);
  });

  const result = await runCli(["connect", "--name", "perms", "--", ...chainArgs()], {
    env,
    input: "hi\n",
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /mode|accessible/);
});
