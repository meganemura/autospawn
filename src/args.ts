// Responsibility: the pure argv-parsing grammar cli.ts uses (split on `--`,
// parse `--flag value` pairs, parse a positive-integer option value). Every
// function here is a plain function of its arguments: no `process.exit`,
// no reading argv or env, no I/O. That is what makes it possible to test
// the grammar itself (with Hegel, in test/) without spawning a process for
// every case, and without deciding here what exit code a syntax error gets
// — that decision belongs to cli.ts's `usageError`.
//
// Not done here: validating a `--name` value's characters (paths.ts owns
// that; it is a different rule from "is this a well-formed flag").

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function err<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

// Splits argv at the first `--`. Everything from the first `--` onward is
// returned as-is in `after`, including any further `--` tokens it
// contains: only the first one is a separator.
export function splitOnDoubleDash(
  args: readonly string[],
): ParseResult<{ before: readonly string[]; after: readonly string[] }> {
  const idx = args.indexOf("--");
  if (idx === -1) {
    return err("missing '--' separating options from the command to run");
  }
  const after = args.slice(idx + 1);
  if (after.length === 0) {
    return err("nothing follows '--'");
  }
  return ok({ before: args.slice(0, idx), after });
}

// Parses a flat list of `--flag value` pairs against a fixed set of known
// flag names. Every flag in `spec` takes exactly one value; an option not
// in `spec`, or one missing its value, is an error rather than silently
// ignored.
export function parseFlags(
  args: readonly string[],
  spec: Readonly<Record<string, "string">>,
): ParseResult<Readonly<Record<string, string>>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!spec[arg]) {
      return err(`unrecognized option '${arg}'`);
    }
    const value = args[i + 1];
    if (value === undefined) {
      return err(`option '${arg}' needs a value`);
    }
    out[arg] = value;
    i += 1;
  }
  return ok(out);
}

// Takes every `flag value` pair out of a flat list of `--flag value` pairs,
// for a flag that may repeat, and returns the values in order with the
// other pairs left for parseFlags. It walks pairs the same way parseFlags
// does, so a value that happens to equal the flag (`--name --param`) stays
// a value.
export function takeRepeated(
  args: readonly string[],
  flag: string,
): ParseResult<{ rest: readonly string[]; values: readonly string[] }> {
  const rest: string[] = [];
  const values: string[] = [];
  // Stryker disable next-line EqualityOperator: one more pass, at i equal
  // to the length, finds no flag and slices an empty pair, so <= ends the
  // same way.
  for (let i = 0; i < args.length; i += 2) {
    const arg = args[i]!;
    const value = args[i + 1];
    if (arg === flag) {
      if (value === undefined) return err(`option '${flag}' needs a value`);
      values.push(value);
    } else {
      // The pair as it stands; a trailing flag with no value stays alone,
      // for parseFlags to report.
      rest.push(...args.slice(i, i + 2));
    }
  }
  return ok({ rest, values });
}

// A positive integer, written with no sign, no leading zero beyond a
// single "0" (which itself is rejected, being not positive), and no other
// non-digit characters. Round-tripping through parseInt and back to a
// string is what rejects "1.5", "1e3", "+1", "01", and leading/trailing
// whitespace: `Number.parseInt` accepts all of those in some form, but
// none of them survives `String(n) === value`.
export function parsePositiveInt(value: string, label: string): ParseResult<number> {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== value) {
    return err(`${label} must be a positive integer, got '${value}'`);
  }
  return ok(n);
}
