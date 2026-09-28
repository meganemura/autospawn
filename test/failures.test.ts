import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
import { encodeLine, readHeaderLine } from "../src/protocol.ts";

function chainArgs(server = "echo-server"): string[] {
  return [
    path.join(fixturesDir, "fake-wrapper"),
    process.execPath,
    cliPath,
    "serve",
    "--idle-timeout",
    "50",
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
  // Exact text, not just a substring: fingerprint_mismatch is one of two
  // branches on the same reply.error check, and both branches' messages
  // happen to contain "stop --name" or similar fragments a loose match
  // could confuse.
  assert.equal(
    second.stderr,
    "autospawn connect: a resident is already running for this --name with a different command. Run 'autospawn stop --name <name>' and reconnect.\n",
  );
});

// A raw fake resident, standing in for serve.ts, that answers "attach"
// with a caller-chosen error reply -- lets an error other than
// fingerprint_mismatch reach connect's own error-printing branch, which
// two real connects racing (the test above) cannot produce on demand.
function startFakeResidentWithError(sockPath: string, reply: { error: string; message: string }): net.Server {
  const server = net.createServer((socket) => {
    readHeaderLine(socket)
      .then(() => socket.write(encodeLine({ ok: false, ...reply })))
      .catch(() => socket.destroy());
  });
  server.listen(sockPath);
  return server;
}

test("attach: a non-fingerprint-mismatch error reply is printed as-is, not as reconnect guidance", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const sockPath = path.join(dir, "othererror.sock");
  const server = startFakeResidentWithError(sockPath, { error: "bad_header", message: "custom text" });
  t.after(() => {
    server.close();
    removeStateDir(dir);
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const result = await runCli(["connect", "--name", "othererror", "--", "true"], {
    env,
    input: "hi\n",
  });
  assert.equal(result.code, 1);
  assert.equal(result.stderr, "autospawn connect: bad_header: custom text\n");
});

// The peer ending the connection (a graceful close, not a socket-level
// error) must end connect right away, even if this process's own stdin is
// still open and would otherwise keep it waiting for more input.
test("attach: the peer closing the connection ends connect immediately, even with stdin still open", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const sockPath = path.join(dir, "earlyclose.sock");
  const server = net.createServer((socket) => {
    readHeaderLine(socket)
      .then(() => socket.write(encodeLine({ ok: true }), () => socket.end()))
      .catch(() => socket.destroy());
  });
  server.listen(sockPath);
  t.after(() => {
    server.close();
    removeStateDir(dir);
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));

  const child = spawn(process.execPath, [cliPath, "connect", "--name", "earlyclose", "--", "true"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  // child.stdin is deliberately never ended.
  const codeOrTimeout = await Promise.race([
    new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code))),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3000)),
  ]);
  if (codeOrTimeout === "timeout") child.kill("SIGKILL");
  assert.notEqual(
    codeOrTimeout,
    "timeout",
    "connect must exit once the peer closes, even with stdin still open",
  );
  assert.equal(codeOrTimeout, 0);
});

test("connect: when the spawn command cannot be found, startChain's rejection still releases the spawn lock", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  t.after(() => removeStateDir(dir));

  const result = await runCli(
    ["connect", "--name", "lockrelease", "--timeout", "5", "--", "/no/such/binary-mas-test"],
    { env },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /__spawn did not report a pid/);
  assert.equal(
    fs.existsSync(path.join(dir, "lockrelease.spawn")),
    false,
    "the spawn lock must be released",
  );
});

// DEAD_PID_GRACE_MS (500ms in connect.ts) is the window connect gives a
// spawn-command that has already exited, before concluding it will never
// answer. Too short a gap here would mean the grace period was skipped
// entirely; the lower bound is what catches that. Measured from the
// spawned process's own exit time (written to a file), not from this
// test's own start, since node startup overhead alone can exceed the
// grace window under load.
test("connect: a dead spawn-command process is given its full grace period before connect gives up", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const diedAtFile = path.join(dir, "died-at");
  t.after(() => removeStateDir(dir));

  const script = "require('fs').writeFileSync(process.argv[1], String(Date.now())); process.exit(1);";
  const result = await runCli(
    ["connect", "--name", "deadgrace", "--timeout", "5", "--", process.execPath, "-e", script, diedAtFile],
    { env },
  );
  const diedAt = Number(fs.readFileSync(diedAtFile, "utf8"));
  const failedAt = Date.now();

  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    `autospawn connect: the spawned command exited before a resident answered (log: ${path.join(dir, "deadgrace.log")})\n`,
  );
  const gapMs = failedAt - diedAt;
  assert.ok(gapMs >= 400 && gapMs < 3000, `expected roughly the 500ms grace period, got ${gapMs}ms`);
  assert.equal(
    fs.existsSync(path.join(dir, "deadgrace.spawn")),
    false,
    "the spawn lock must be released",
  );
});

// A spawn-command that is merely slow to start listening must not be
// mistaken for one that already exited: its pid stays alive throughout.
test("connect: a spawn-command that is slow to listen is not mistaken for one that already exited", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const pidFile = path.join(dir, "slow.pid");
  t.after(() => {
    try {
      const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (Number.isInteger(pid)) process.kill(pid, "SIGKILL");
    } catch {
      // already gone, or never started
    }
    void runCli(["stop", "--name", "slowstart"], { env });
    removeStateDir(dir);
  });

  const start = Date.now();
  const result = await runCli(
    [
      "connect",
      "--name",
      "slowstart",
      "--timeout",
      "10",
      "--",
      path.join(fixturesDir, "slow-wrapper"),
      process.execPath,
      cliPath,
      "serve",
      "--idle-timeout",
      "50",
      "--",
      path.join(fixturesDir, "echo-server"),
    ],
    { env: { ...env, SLOW_WRAPPER_SLEEP: "2", SLOW_WRAPPER_PID_FILE: pidFile }, input: "hi\n" },
  );
  const elapsed = Date.now() - start;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "hi\n");
  assert.ok(elapsed >= 1800, `must actually wait for the slow start, took ${elapsed}ms`);
});

// The outer --timeout deadline (distinct from the dead-pid grace period
// above) is what ends connect when the spawn-command stays alive but
// never gets around to listening at all.
test("connect: a holder gives up after --timeout if the resident never starts listening, and releases its lock", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  const pidFile = path.join(dir, "slow.pid");
  t.after(() => {
    try {
      const pid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
      if (Number.isInteger(pid)) process.kill(pid, "SIGKILL");
    } catch {
      // already gone, or never started
    }
    removeStateDir(dir);
  });

  const start = Date.now();
  const result = await runCli(
    ["connect", "--name", "holdertimeout", "--timeout", "1", "--", path.join(fixturesDir, "slow-wrapper")],
    { env: { ...env, SLOW_WRAPPER_SLEEP: "3", SLOW_WRAPPER_PID_FILE: pidFile } },
  );
  const elapsed = Date.now() - start;
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    `autospawn connect: timed out after 1s waiting for a resident (log: ${path.join(dir, "holdertimeout.log")})\n`,
  );
  assert.ok(elapsed >= 900 && elapsed < 4000, `expected roughly a 1s wait, took ${elapsed}ms`);
  assert.equal(
    fs.existsSync(path.join(dir, "holdertimeout.spawn")),
    false,
    "the spawn lock must be released",
  );
});

// The waiter branch's own deadline (a connect that found someone else's
// in-flight lock, not its own chain to watch) is a separate check from the
// holder's above. The lock is dated into the future so this waiter's own
// --timeout, not the lock's staleness check, is what ends the wait, even
// if this process is slow to start under load.
test("connect: a waiter gives up after its own --timeout when no resident ever appears", async (t) => {
  const dir = makeStateDir();
  const env = baseEnv(dir);
  t.after(() => removeStateDir(dir));

  const lockPath = path.join(dir, "waitertimeout.spawn");
  fs.writeFileSync(lockPath, "1\n", { mode: 0o600 });
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(lockPath, future, future);

  const start = Date.now();
  const result = await runCli(["connect", "--name", "waitertimeout", "--timeout", "1", "--", "true"], {
    env,
  });
  const elapsed = Date.now() - start;
  assert.equal(result.code, 1);
  assert.equal(
    result.stderr,
    `autospawn connect: timed out after 1s waiting for a resident (log: ${path.join(dir, "waitertimeout.log")})\n`,
  );
  assert.ok(elapsed >= 900 && elapsed < 5000, `expected roughly a 1s wait, took ${elapsed}ms`);
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
  // Exact line, not just a substring: this is the top-level catch in
  // cli.ts, whose `(err as Error).message ?? err` reduces a real Error to
  // its own message with no "Error: " prefix. `?? err` mutated to
  // `&& err` would instead interpolate the whole Error object (whose
  // template-literal stringification prepends "Error: "), which a
  // substring match alone cannot tell apart from the correct form.
  const [firstLine] = result.stderr.split("\n");
  assert.equal(firstLine, `autospawn: ${dir} is accessible to group or other (mode 755); run 'chmod 700 ${dir}' before retrying`);
});
