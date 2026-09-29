// Responsibility: the rules for per-connection values (ADR 0008 and ADR
// 0010). A connect sends `key=value` pairs; a serve declares which keys it
// accepts. `--param` puts a value in the child's environment, under a name
// the config chooses; `--arg` puts one of an enumerated set of values into
// the server command's argv, at a `{key}` placeholder the config wrote.
// Both sides check with the same functions: connect for a clear error
// before it sends anything, serve because anything can reach the socket
// without connect.
//
// Not done here: judging what a value means. The program still has to treat
// it as untrusted data; this module only checks its shape.
import type { ParseResult } from "./args.ts";

const KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A value lands in the child's environment. A newline in it could forge a
// log line when the program prints it, so no control character passes.
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
export const MAX_VALUE_BYTES = 4096;

export type Params = Readonly<Record<string, string>>;

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function err<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function keyError(key: string): string | null {
  return KEY_PATTERN.test(key) ? null : `invalid parameter name '${key}': must match ${KEY_PATTERN}`;
}

export function valueError(key: string, value: string): string | null {
  if (CONTROL_CHAR.test(value)) {
    return `parameter '${key}' has a control character in its value`;
  }
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) {
    return `parameter '${key}' is longer than ${MAX_VALUE_BYTES} bytes`;
  }
  return null;
}

// Splits `key=value` at the first "=". The value may itself contain "=".
function splitPair(pair: string): [string, string] | null {
  const idx = pair.indexOf("=");
  if (idx === -1) return null;
  return [pair.slice(0, idx), pair.slice(idx + 1)];
}

// connect's `--param key=value` values, as the attach header sends them.
export function parseConnectParams(pairs: readonly string[]): ParseResult<Params> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const split = splitPair(pair);
    if (!split) return err(`--param '${pair}' is not key=value`);
    const [key, value] = split;
    const problem = keyError(key) ?? valueError(key, value);
    if (problem) return err(problem);
    if (Object.hasOwn(out, key)) return err(`--param '${key}' is given twice`);
    out[key] = value;
  }
  return ok(out);
}

// serve's `--param key=ENV_NAME` values: which keys it accepts, and the
// variable each one sets in the child. env is serve's own environment: a
// declared name that is already set there is refused, since a caller could
// otherwise replace a value that the config or the wrapper put there, such
// as the URL the program sends its credentials to.
export function parseServeParams(
  pairs: readonly string[],
  env: NodeJS.ProcessEnv,
): ParseResult<Params> {
  const out: Record<string, string> = {};
  const names = new Set<string>();
  for (const pair of pairs) {
    const split = splitPair(pair);
    if (!split) return err(`--param '${pair}' is not key=ENV_NAME`);
    const [key, name] = split;
    const problem = keyError(key);
    if (problem) return err(problem);
    if (!ENV_NAME_PATTERN.test(name)) {
      return err(`invalid environment variable name '${name}' for parameter '${key}'`);
    }
    if (name.startsWith("AUTOSPAWN_")) {
      return err(`parameter '${key}' cannot set ${name}: AUTOSPAWN_ names belong to autospawn`);
    }
    if (Object.hasOwn(env, name)) {
      return err(`parameter '${key}' would replace ${name}, which is already set`);
    }
    if (Object.hasOwn(out, key)) return err(`--param '${key}' is declared twice`);
    if (names.has(name)) return err(`${name} is declared for two parameters`);
    out[key] = name;
    names.add(name);
  }
  return ok(out);
}

// Checks the params of one attach against serve's --param declarations,
// and returns the environment variables to add to that connection's child.
// A key --arg declared instead is not this function's concern; the caller
// removes those keys before calling this, so an --arg key never has to
// pass valueError here (a value that reached the enumeration already did,
// at --arg parse time) and never reports "not declared" by mistake.
export function childParamEnv(
  params: Params,
  declared: Params,
): ParseResult<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!Object.hasOwn(declared, key)) return err(`parameter '${key}' is not declared`);
    const problem = valueError(key, value);
    if (problem) return err(problem);
    out[declared[key]!] = value;
  }
  return ok(out);
}

export type ArgValues = Readonly<Record<string, readonly string[]>>;

// serve's `--arg key=v1,v2,...` values: which keys a connection may choose
// among, and the values it may choose from. Cross-checked against the
// already-parsed --param declarations, so a key never has two meanings
// (which side of the child it reaches, env or argv, would then depend on
// which one the code happened to check first).
export function parseServeArgs(
  pairs: readonly string[],
  declaredParams: Params,
): ParseResult<ArgValues> {
  const out: Record<string, readonly string[]> = {};
  for (const pair of pairs) {
    const split = splitPair(pair);
    if (!split) return err(`--arg '${pair}' is not key=value[,value...]`);
    const [key, rawValues] = split;
    const problem = keyError(key);
    if (problem) return err(problem);
    if (Object.hasOwn(declaredParams, key)) {
      return err(`--arg '${key}' is already declared by --param`);
    }
    if (Object.hasOwn(out, key)) return err(`--arg '${key}' is declared twice`);
    const values = rawValues.split(",");
    const seen = new Set<string>();
    for (const value of values) {
      if (value.length === 0) return err(`--arg '${key}' has an empty value in its list`);
      const valueProblem = valueError(key, value);
      if (valueProblem) return err(valueProblem);
      if (seen.has(value)) return err(`--arg '${key}' lists the value '${value}' twice`);
      seen.add(value);
    }
    out[key] = values;
  }
  return ok(out);
}

// Startup checks that keep an --arg declaration from doing something the
// person who wrote the config did not intend. Checked once, before serve
// binds its socket, not per connection: a serverCommand that fails this
// never runs at all.
//
// A declared key in the command itself (argv[0]) would let a caller decide
// which program runs, the exact hole ADR 0008 closed for --param; this
// keeps --arg from reopening it. A declared key that appears nowhere in
// the rest of the command is very likely a typo: the config declared a
// choice the command never uses.
export function checkServeArgsCommand(
  declaredArgs: ArgValues,
  serverCommand: readonly string[],
): ParseResult<true> {
  // cli.ts only reaches this after splitOnDoubleDash, which refuses an
  // empty command, so serverCommand always has a first element.
  const [command, ...rest] = serverCommand;
  for (const key of Object.keys(declaredArgs)) {
    const placeholder = `{${key}}`;
    if (command!.includes(placeholder)) {
      return err(
        `--arg '${key}' cannot appear in the server command's first word: a caller must not choose which program runs`,
      );
    }
    if (!rest.some((token) => token.includes(placeholder))) {
      return err(`--arg '${key}' does not appear in the server command`);
    }
  }
  return ok(true);
}

// Checks one attach's params against serve's --arg declarations, and
// returns the values to substitute into the server command for that
// connection. Unlike --param, a declared --arg key is required: the server
// command already has its placeholder, and an unset one would run the
// literal "{key}" text as part of the child's argv.
export function resolveDeclaredArgs(
  params: Params,
  declaredArgs: ArgValues,
): ParseResult<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(declaredArgs)) {
    if (!Object.hasOwn(params, key)) return err(`parameter '${key}' is required`);
    const value = params[key]!;
    const allowed = declaredArgs[key]!;
    if (!allowed.includes(value)) return err(`parameter '${key}' is not one of its declared values`);
    out[key] = value;
  }
  return ok(out);
}

// Substitutes `{key}` in each token of the server command with that
// connection's chosen value, in a single pass over the original text: a
// value that itself contains "{" or "}" is not scanned again for more
// placeholders, and a key the config did not declare is left as literal
// text. A Map, not a plain object, backs the lookup, so a key such as
// "constructor" (which KEY_PATTERN allows) cannot resolve to anything but
// the value declared for it.
export function substituteServerCommand(
  serverCommand: readonly string[],
  values: Readonly<Record<string, string>>,
): string[] {
  const keys = Object.keys(values);
  if (keys.length === 0) return [...serverCommand];
  const lookup = new Map(Object.entries(values));
  const pattern = new RegExp(keys.map((key) => `\\{${key}\\}`).join("|"), "g");
  return serverCommand.map((token) => token.replace(pattern, (match) => lookup.get(match.slice(1, -1))!));
}
