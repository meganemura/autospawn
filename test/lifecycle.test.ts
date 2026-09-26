import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { baseEnv, cliPath, fixturesDir, makeStateDir, removeStateDir, runCli, waitFor } from "./helpers.ts";

function chainArgs(server = "echo-server", serveArgs: string[] = []): string[] {
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
