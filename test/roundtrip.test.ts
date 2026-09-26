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
  sleep,
  waitFor,
} from "./helpers.ts";

// The spawn-command every test in this file uses: a fake secrets wrapper
// (records that it ran, adds an env var) that execs into `serve`, which in
// turn runs the fake MCP echo server.
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

async function connectRoundtrip(
  name: string,
  env: NodeJS.ProcessEnv,
  payload: string,
  countFile: string,
  server = "echo-server",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runCli(["connect", "--name", name, "--", ...chainArgs(server)], {
    env: { ...env, FAKE_WRAPPER_COUNT_FILE: countFile },
    input: payload,
  });
}

test("two connects share one resident (wrapper runs once)", async (t) => {
  const dir = makeStateDir();
  const countFile = path.join(dir, "count");
  const env = baseEnv(dir);
  t.after(() => {
    void runCli(["stop", "--name", "shared"], { env });
    removeStateDir(dir);
  });

  const first = await connectRoundtrip("shared", env, "one\n", countFile);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, "one\n");

  const second = await connectRoundtrip("shared", env, "two\n", countFile);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, "two\n");

  assert.equal(fs.readFileSync(countFile, "utf8").length, 1, "wrapper should run exactly once");
});

test("wrapper's env reaches the MCP server child", async (t) => {
  const dir = makeStateDir();
  const countFile = path.join(dir, "count");
  const env = baseEnv(dir);
  t.after(() => {
    void runCli(["stop", "--name", "envtest"], { env });
    removeStateDir(dir);
  });

  const result = await connectRoundtrip(
    "envtest",
    env,
    "ping\n",
    countFile,
    "echo-server-envprobe",
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "env:shh\nping\n");
});

test("stdin to stdout round trip, byte-exact, header trailing bytes preserved", async (t) => {
  const dir = makeStateDir();
  const countFile = path.join(dir, "count");
  const env = baseEnv(dir);
  t.after(() => {
    void runCli(["stop", "--name", "roundtrip"], { env });
    removeStateDir(dir);
  });

  const payload = "line one\nline two\nline three\n";
  const result = await connectRoundtrip("roundtrip", env, payload, countFile);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, payload);
});

test("connect writes nothing but the relay to stdout", async (t) => {
  const dir = makeStateDir();
  const countFile = path.join(dir, "count");
  const env = baseEnv(dir);
  t.after(() => {
    void runCli(["stop", "--name", "stdoutpure"], { env });
    removeStateDir(dir);
  });

  const payload = "exact-bytes\n";
  const result = await connectRoundtrip("stdoutpure", env, payload, countFile);
  assert.equal(result.code, 0, result.stderr);
  // Exact equality (not just "contains"): any diagnostic text mixed into
  // stdout would break this, since echo-server returns exactly what it was
  // sent.
  assert.equal(result.stdout, payload);
});

test("two concurrent connects converge on one resident, both round-trip", async (t) => {
  const dir = makeStateDir();
  const countFile = path.join(dir, "count");
  const env = baseEnv(dir);
  t.after(() => {
    void runCli(["stop", "--name", "concurrent"], { env });
    removeStateDir(dir);
  });

  const [a, b] = await Promise.all([
    connectRoundtrip("concurrent", env, "alpha\n", countFile),
    connectRoundtrip("concurrent", env, "beta\n", countFile),
  ]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(a.stdout, "alpha\n");
  assert.equal(b.stdout, "beta\n");
  // Both connects found no resident and raced to start one. The spawn lock
  // (see connect.ts) must let only one of them actually run the wrapper;
  // otherwise the loser would have triggered its own 1Password approval
  // for a resident that never ends up serving anyone.
  assert.equal(
    fs.readFileSync(countFile, "utf8").length,
    1,
    "the wrapper must run exactly once even when two connects race",
  );
});
