// End-to-end tests of cli.ts's own dispatch (--help/--version/usage
// errors/unknown command), run through the real CLI subprocess. Every
// other test file spawns the CLI too, but for a subcommand's own
// behavior (connect/serve/stop); nothing before this file exercised
// cli.ts's dispatch logic itself in isolation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "./helpers.ts";

const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const packageVersion = (
  JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version: string }
).version;

test("--help / -h: prints usage to stdout and exits 0", async () => {
  for (const flag of ["--help", "-h"]) {
    const result = await runCli([flag]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /usage: mcp-autospawn <command>/);
    assert.match(result.stdout, /connect --name/);
    assert.equal(result.stderr, "");
  }
});

test("no arguments: prints usage to stdout and exits 2", async () => {
  const result = await runCli([]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /usage: mcp-autospawn <command>/);
});

test("--version / -v: prints exactly the package.json version and exits 0", async () => {
  for (const flag of ["--version", "-v"]) {
    const result = await runCli([flag]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${packageVersion}\n`);
  }
});

test("an unknown command is a usage error: exit 2, message names it, usage follows", async () => {
  const result = await runCli(["bogus-command"]);
  assert.equal(result.code, 2);
  const [firstLine] = result.stderr.split("\n");
  assert.equal(firstLine, "mcp-autospawn: unknown command 'bogus-command'");
  assert.match(result.stderr, /usage: mcp-autospawn <command>/);
});

test("connect without --name is a usage error", async () => {
  const result = await runCli(["connect", "--", "echo"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /connect requires --name/);
});

test("stop without --name is a usage error", async () => {
  const result = await runCli(["stop"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /stop requires --name/);
});

test("connect with no '--' is a usage error, at the CLI level (not just in args.ts's own unit tests)", async () => {
  const result = await runCli(["connect", "--name", "x"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /missing '--'/);
});

test("__spawn with no log path is a usage error", async () => {
  const result = await runCli(["__spawn"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /__spawn requires a log path/);
});

test("connect --timeout takes only the flag's own value, not a value meant for another flag", async () => {
  // Regression guard for the two StringLiteral mutants on
  // flags["--timeout"]: if either lookup used the wrong key, this test
  // would either usage-error on a well-formed --timeout, or silently
  // accept a value never validated as this flag's own.
  const result = await runCli(["connect", "--name", "x", "--timeout", "abc", "--", "echo"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--timeout must be a positive integer, got 'abc'/);
});

test("connect rejects an invalid --name at the CLI level, not just inside paths.ts's own tests", async () => {
  // validateName throws PathError, which main()'s dispatch does not
  // catch itself -- it propagates to the top-level catch (exit 1), not
  // the usageError convention (exit 2) the rest of this file's cases use.
  const result = await runCli(["connect", "--name", "has space", "--", "echo"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid --name/);
});

test("stop rejects an invalid --name at the CLI level", async () => {
  const result = await runCli(["stop", "--name", "has space"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid --name/);
});

test("serve --idle-timeout takes only its own value", async () => {
  const result = await runCli(["serve", "--idle-timeout", "abc", "--", "echo"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--idle-timeout must be a positive integer, got 'abc'/);
});
