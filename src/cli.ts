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
import { connect } from "./connect.ts";
import { validateName } from "./paths.ts";
import { serve } from "./serve.ts";
import { runSpawnChain } from "./spawn-chain.ts";
import { stop } from "./stop.ts";

const USAGE = `usage: mcp-autospawn <command> [options]

commands:
  connect --name <name> [--timeout <seconds>] -- <spawn-command...>
  serve [--idle-timeout <seconds>] -- <server-command...>
  stop --name <name>

  -h, --help     show this message
  -v, --version  show the version number
`;

function usageError(message: string): never {
  process.stderr.write(`mcp-autospawn: ${message}\n`);
  process.stderr.write(USAGE);
  process.exit(2);
}

function splitOnDoubleDash(args: string[]): { before: string[]; after: string[] } {
  const idx = args.indexOf("--");
  if (idx === -1) usageError("missing '--' separating options from the command to run");
  const before = args.slice(0, idx);
  const after = args.slice(idx + 1);
  if (after.length === 0) usageError("nothing follows '--'");
  return { before, after };
}

function parseFlags(
  args: string[],
  spec: Record<string, "string">,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const kind = spec[arg];
    if (!kind) usageError(`unrecognized option '${arg}'`);
    const value = args[i + 1];
    if (value === undefined) usageError(`option '${arg}' needs a value`);
    out[arg] = value;
    i += 1;
  }
  return out;
}

function parsePositiveInt(value: string, label: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== value) {
    usageError(`${label} must be a positive integer, got '${value}'`);
  }
  return n;
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
    const { before, after } = splitOnDoubleDash(rest);
    const flags = parseFlags(before, { "--name": "string", "--timeout": "string" });
    const name = flags["--name"];
    if (!name) usageError("connect requires --name <name>");
    validateName(name);
    const timeout = flags["--timeout"] ? parsePositiveInt(flags["--timeout"], "--timeout") : undefined;
    await connect(name, timeout, after);
    return;
  }

  if (command === "serve") {
    const { before, after } = splitOnDoubleDash(rest);
    const flags = parseFlags(before, { "--idle-timeout": "string" });
    const idleTimeout = flags["--idle-timeout"]
      ? parsePositiveInt(flags["--idle-timeout"], "--idle-timeout")
      : null;
    await serve(idleTimeout, after);
    return;
  }

  if (command === "stop") {
    const flags = parseFlags(rest, { "--name": "string" });
    const name = flags["--name"];
    if (!name) usageError("stop requires --name <name>");
    validateName(name);
    await stop(name);
    return;
  }

  if (command === "__spawn") {
    const [logPath, ...spawnRest] = rest;
    if (!logPath) usageError("__spawn requires a log path");
    const { after } = splitOnDoubleDash(spawnRest);
    runSpawnChain(logPath, after);
    return;
  }

  usageError(`unknown command '${command}'`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`mcp-autospawn: ${(err as Error).message ?? err}\n`);
  process.exit(1);
});
