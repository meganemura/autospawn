import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
  waitForListening,
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
  await waitForListening(sockPath);
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

// --param end to end: one resident, one wrapper run, and each connection's
// child sees the value its own connect sent.
function paramChainArgs(): string[] {
  return [
    path.join(fixturesDir, "fake-wrapper"),
    process.execPath,
    cliPath,
    "serve",
    "--idle-timeout",
    "10",
    "--param",
    "topic=PROBE_TOPIC",
    "--",
    path.join(fixturesDir, "echo-server-paramprobe"),
  ];
}

test("--param: two connects with different values share one resident, and each child sees its own", async (t) => {
  const dir = makeStateDir();
  const countFile = path.join(dir, "count");
  const env = { ...baseEnv(dir), FAKE_WRAPPER_COUNT_FILE: countFile };
  t.after(async () => {
    await runCli(["stop", "--name", "params"], { env });
    removeStateDir(dir);
  });

  const connectWith = (topic: string) =>
    runCli(["connect", "--name", "params", "--param", `topic=${topic}`, "--", ...paramChainArgs()], {
      env,
      input: "hi\n",
    });

  const first = await connectWith("proj-a");
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, "topic:proj-a\nhi\n");

  const second = await connectWith("proj-b");
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, "topic:proj-b\nhi\n");

  const none = await runCli(["connect", "--name", "params", "--", ...paramChainArgs()], {
    env,
    input: "hi\n",
  });
  assert.equal(none.stdout, "topic:unset\nhi\n");

  assert.equal(fs.readFileSync(countFile, "utf8").length, 1, "wrapper should run exactly once");
});

test("--param: a key the resident did not declare is refused with bad_param", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  t.after(async () => {
    await runCli(["stop", "--name", "undeclared"], { env });
    removeStateDir(dir);
  });

  const result = await runCli(
    ["connect", "--name", "undeclared", "--param", "other=x", "--", ...paramChainArgs()],
    { env, input: "hi\n" },
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /bad_param: parameter 'other' is not declared/);
});

test("--param: connect refuses a malformed value before it contacts anything", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  t.after(() => removeStateDir(dir));

  const result = await runCli(
    ["connect", "--name", "badvalue", "--param", "topic=a\u0001b", "--", ...paramChainArgs()],
    { env, input: "" },
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /control character/);
  assert.equal(fs.existsSync(path.join(dir, "badvalue.sock")), false);
});

test("--param: serve refuses to declare a variable its environment already holds", async () => {
  const result = await runCli(
    ["serve", "--param", "home=HOME", "--", path.join(fixturesDir, "echo-server")],
    { env: { ...process.env, AUTOSPAWN_SOCKET: "/nonexistent/x.sock", AUTOSPAWN_FINGERPRINT: "f" } },
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /would replace HOME, which is already set/);
});

// Exit status (ADR 0009): connect exits the way the child did.
for (const [server, code, why] of [
  ["exit3", 3, "the child's own code"],
  ["self-term", 143, "128 plus SIGTERM's number"],
  ["no-such-server", 127, "127 for a command that cannot start"],
] as const) {
  test(`connect exits with ${why}`, async (t) => {
    const dir = makeStateDir();
    const name = `exit-${server}`;
    const env = baseEnv(dir);
    t.after(async () => {
      await runCli(["stop", "--name", name], { env });
      removeStateDir(dir);
    });
    const result = await runCli(["connect", "--name", name, "--", ...chainArgs(server)], { env, input: "" });
    assert.equal(result.code, code, result.stderr);
    assert.equal(result.stdout, server === "no-such-server" ? "" : "out\n");
  });
}

// A fake resident on the socket, so a test can play a serve from 0.1.0 or
// a serve that breaks off. It answers the attach header with `reply`, then
// writes `body` and closes.
async function fakeResident(
  sockPath: string,
  reply: string,
  body: Buffer,
): Promise<{ server: net.Server; headers: string[] }> {
  const headers: string[] = [];
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx === -1 || headers.length > 0) return;
      headers.push(buf.slice(0, idx));
      sock.write(reply + "\n");
      sock.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  fs.chmodSync(sockPath, 0o600);
  return { server, headers };
}

test("connect falls back to the raw relay for a serve that does not frame, and exits 0", async (t) => {
  const dir = makeStateDir();
  const { server, headers } = await fakeResident(path.join(dir, "oldserve.sock"), '{"ok":true}', Buffer.from("raw bytes\n"));
  t.after(() => {
    server.close();
    removeStateDir(dir);
  });
  const result = await runCli(["connect", "--name", "oldserve", "--", "unused"], { env: baseEnv(dir), input: "" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "raw bytes\n");
  assert.equal(JSON.parse(headers[0]!).frames, 1, "connect asks for frames");
});

test("connect exits 1 when a framed connection closes before the exit frame", async (t) => {
  const dir = makeStateDir();
  const data = Buffer.from("partial\n");
  const frame = Buffer.concat([Buffer.from([1, 0, 0, 0, data.length]), data]);
  const { server } = await fakeResident(path.join(dir, "cutoff.sock"), '{"ok":true,"frames":1}', frame);
  t.after(() => {
    server.close();
    removeStateDir(dir);
  });
  const result = await runCli(["connect", "--name", "cutoff", "--", "unused"], { env: baseEnv(dir), input: "" });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "partial\n");
  assert.match(result.stderr, /closed before the program's exit status arrived/);
});

test("connect exits 1 with a message on a frame it cannot read", async (t) => {
  const dir = makeStateDir();
  const bad = Buffer.from([2, 0, 0, 0, 4, ...Buffer.from("null")]);
  const { server } = await fakeResident(path.join(dir, "badframe.sock"), '{"ok":true,"frames":1}', bad);
  t.after(() => {
    server.close();
    removeStateDir(dir);
  });
  const result = await runCli(["connect", "--name", "badframe", "--", "unused"], { env: baseEnv(dir), input: "" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /bad frame from the resident: exit frame is not \{code, signal\}/);
});
