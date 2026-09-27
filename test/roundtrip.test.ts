import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { fingerprintArgv } from "../src/protocol.ts";
import {
  baseEnv,
  cliPath,
  fixturesDir,
  isDead,
  makeStateDir,
  removeStateDir,
  runCli,
  runCliBinary,
  sleep,
  startServeDirect,
  waitFor,
} from "./helpers.ts";

// The spawn-command every test in this file uses: a fake secrets wrapper
// (records that it ran, adds an env var) that execs into `serve`, which in
// turn runs the echo server.
function chainArgs(server = "echo-server"): string[] {
  return [
    path.join(fixturesDir, "fake-wrapper"),
    process.execPath,
    cliPath,
    "serve",
    // A killed test (a mutation-testing timeout, for example) skips this
    // file's t.after() cleanup; --idle-timeout bounds how long any
    // resident it started outlives it.
    "--idle-timeout",
    "10",
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

test("connect: a successful holder connect leaves no spawn lock behind", async (t) => {
  const dir = makeStateDir();
  const countFile = path.join(dir, "count");
  const env = baseEnv(dir);
  t.after(() => {
    void runCli(["stop", "--name", "lockcheck"], { env });
    removeStateDir(dir);
  });

  const result = await connectRoundtrip("lockcheck", env, "hi\n", countFile);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(dir, "lockcheck.spawn")), false);
});

// The empty autospawn-vars line guards the chain marker. connect puts
// AUTOSPAWN_IN_CHAIN, AUTOSPAWN_SOCKET, and AUTOSPAWN_FINGERPRINT into the
// chain's environment, and serve must strip them before it starts the
// server. If the marker reached the server, a server that itself runs
// `autospawn connect` for another name would be refused as a recursion.
test("wrapper's env reaches the server child, and autospawn's own variables do not", async (t) => {
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
  assert.equal(result.stdout, "env:shh\nautospawn-vars:\nping\n");
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

test("relay: arbitrary binary survives connect -> serve -> echo unchanged", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const sockPath = path.join(dir, "relayprop.sock");
  const relayChain = chainArgs();
  // One resident, shared across every draw below: each Hegel test case
  // only pays for a fresh `connect` subprocess, not a fresh spawn chain.
  const resident = startServeDirect(sockPath, fingerprintArgv(relayChain), "echo-server", 30);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });
  t.after(() => {
    if (!isDead(resident.pid!)) resident.kill("SIGTERM");
    removeStateDir(dir);
  });

  await hegel.testAsync(
    async (tc) => {
      // Full byte range (0x00 through 0xff), so this covers NUL, "\n",
      // and byte sequences that are not valid UTF-8 -- connect and serve
      // relay bytes without ever decoding them as text, and this is the
      // property that would catch it if one of them started to.
      const payload = Buffer.from(tc.draw(gs.binary({ minSize: 0, maxSize: 500 })));
      const result = await runCliBinary(["connect", "--name", "relayprop", "--", ...relayChain], {
        env,
        input: payload,
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(Buffer.compare(result.stdout, payload), 0);
    },
    { testCases: 20 },
  );
});
