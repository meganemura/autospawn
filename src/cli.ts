#!/usr/bin/env node
// Responsibility: parse argv into one of the three public subcommands
// (connect, serve, stop) plus the hidden __spawn helper, and dispatch. No
// third-party argument parser: each added dependency needs a reason, and
// the grammar here is small enough to parse by hand.
//
// Not done here: anything about sockets, spawning, or secrets. This module
// only turns argv into calls into connect.ts / serve.ts / stop.ts /
// spawn-chain.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFlags, parsePositiveInt, splitOnDoubleDash, type ParseResult } from "./args.ts";
import { connect } from "./connect.ts";
import { validateName } from "./paths.ts";
import { serve } from "./serve.ts";
import { runSpawnChain } from "./spawn-chain.ts";
import { stop } from "./stop.ts";

const USAGE = `usage: autospawn <command> [options]

commands:
  connect --name <name> [--timeout <seconds>] -- <spawn-command...>
  serve [--idle-timeout <seconds>] -- <server-command...>
  stop --name <name>

  -h, --help     show this message
  -v, --version  show the version number
`;

function usageError(message: string): never {
  process.stderr.write(`autospawn: ${message}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

// Unwraps a ParseResult from args.ts, translating a parse failure into
// this process's own exit(2)-with-usage convention. args.ts stays free of
// that decision so its grammar can be tested without a process to exit.
function orUsageError<T>(result: ParseResult<T>): T {
  if (!result.ok) usageError(result.error);
  return result.value;
}

function readVersion(): string {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version: string };
  return pkg.version;
}

async function main(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  if (argv[0] === "-v" || argv[0] === "--version") {
    process.stdout.write(`${readVersion()}\n`);
    process.exit(0);
  }

  const [command, ...rest] = argv;

  if (command === "connect") {
    const { before, after } = orUsageError(splitOnDoubleDash(rest));
    const flags = orUsageError(
      parseFlags(before, { "--name": "string", "--timeout": "string" }),
    );
    const name = flags["--name"];
    if (!name) usageError("connect requires --name <name>");
    validateName(name);
    const timeout = flags["--timeout"]
      ? orUsageError(parsePositiveInt(flags["--timeout"], "--timeout"))
      : undefined;
    await connect(name, timeout, after);
    return;
  }

  if (command === "serve") {
    const { before, after } = orUsageError(splitOnDoubleDash(rest));
    const flags = orUsageError(parseFlags(before, { "--idle-timeout": "string" }));
    const idleTimeout = flags["--idle-timeout"]
      ? orUsageError(parsePositiveInt(flags["--idle-timeout"], "--idle-timeout"))
      : null;
    await serve(idleTimeout, after);
    return;
  }

  if (command === "stop") {
    const flags = orUsageError(parseFlags(rest, { "--name": "string" }));
    const name = flags["--name"];
    if (!name) usageError("stop requires --name <name>");
    validateName(name);
    await stop(name);
    return;
  }

  if (command === "__spawn") {
    const [logPath, ...spawnRest] = rest;
    if (!logPath) usageError("__spawn requires a log path");
    const { after } = orUsageError(splitOnDoubleDash(spawnRest));
    runSpawnChain(logPath, after);
    return;
  }

  usageError(`unknown command '${command}'`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`autospawn: ${(err as Error).message ?? err}\n`);
  process.exit(1);
});
