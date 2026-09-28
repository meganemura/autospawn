// Responsibility: the rules for per-connection parameters (ADR 0008). A
// connect sends `key=value` pairs; a serve declares which keys it accepts
// and the environment variable each one sets in the child. Both sides check
// with the same functions: connect for a clear error before it sends
// anything, serve because anything can reach the socket without connect.
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

// Checks the params of one attach against serve's declarations, and returns
// the environment variables to add to that connection's child.
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
