import test from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseFlags, parsePositiveInt, splitOnDoubleDash, type ParseResult } from "../src/args.ts";

// Asserts the result is an error carrying a non-empty, specific message
// (not just "ok: false") -- a mutant that empties the message string
// still needs to fail somewhere, and this is where.
function assertErr(result: ParseResult<unknown>, expectedSubstring: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, new RegExp(escapeRegExp(expectedSubstring)));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A small alphabet of tokens (flag-like strings, plainargv, and "--"
// itself) so hegel builds realistic argv arrays instead of only ever
// drawing arbitrary unicode text, while still letting "--" show up more
// than once, in any position, including none at all.
const tokenGen = gs.sampledFrom([
  "--",
  "--name",
  "--timeout",
  "--idle-timeout",
  "--unknown-flag",
  "value",
  "connect",
  "-h",
  "",
]);

test("splitOnDoubleDash: splits at the first '--'; later '--' tokens ride along in `after`", () =>
  hegel.test((tc) => {
    const noDoubleDash = tokenGen.filter((s) => s !== "--");
    const before = tc.draw(gs.arrays(noDoubleDash, { maxSize: 6 }));
    // `after` draws from the full alphabet, including "--" itself: only
    // the first "--" in the whole argv is a separator, so a later one
    // must ride along inside `after` unchanged.
    const after = tc.draw(gs.arrays(tokenGen, { minSize: 1, maxSize: 6 }));
    const args = [...before, "--", ...after];

    const result = splitOnDoubleDash(args);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.before, before);
    assert.deepEqual(result.value.after, after);
  }));

test("splitOnDoubleDash: no '--' is always an error", () =>
  hegel.test((tc) => {
    const args = tc.draw(gs.arrays(tokenGen.filter((s) => s !== "--"), { maxSize: 10 }));
    const result = splitOnDoubleDash(args);
    assertErr(result, "missing '--'");
  }));

test("splitOnDoubleDash: '--' with nothing after it is always an error", () =>
  hegel.test((tc) => {
    const before = tc.draw(gs.arrays(tokenGen.filter((s) => s !== "--"), { maxSize: 10 }));
    const result = splitOnDoubleDash([...before, "--"]);
    assertErr(result, "nothing follows '--'");
  }));

test("parseFlags: every known flag needs a value; an unknown flag is always an error", () =>
  hegel.test((tc) => {
    const spec = { "--name": "string", "--timeout": "string" } as const;
    // Build a sequence of (flag, value) pairs so we can predict the
    // expected outcome ourselves, rather than reimplementing the parser as
    // the oracle.
    const pairCount = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
    const pairs: Array<[string, string]> = [];
    let expectUnknown = false;
    for (let i = 0; i < pairCount; i += 1) {
      const useKnown = tc.draw(gs.booleans());
      const flag = useKnown
        ? tc.draw(gs.sampledFrom(["--name", "--timeout"] as const))
        : tc.draw(gs.sampledFrom(["--bogus", "--nope"] as const));
      if (!useKnown) expectUnknown = true;
      const value = tc.draw(gs.text({ maxSize: 5 }));
      pairs.push([flag, value]);
    }
    const args = pairs.flat();
    const result = parseFlags(args, spec);

    if (expectUnknown) {
      const firstUnknown = pairs.find(([flag]) => flag === "--bogus" || flag === "--nope")![0];
      assertErr(result, `unrecognized option '${firstUnknown}'`);
      return;
    }
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Last write wins for a repeated flag, same as a plain object literal.
    const expected: Record<string, string> = {};
    for (const [flag, value] of pairs) expected[flag] = value;
    assert.deepEqual(result.value, expected);
  }));

test("parseFlags: a known flag with no following value is always an error", () =>
  hegel.test((tc) => {
    const flag = tc.draw(gs.sampledFrom(["--name", "--timeout"] as const));
    const result = parseFlags([flag], { "--name": "string", "--timeout": "string" });
    assertErr(result, `option '${flag}' needs a value`);
  }));

test("parsePositiveInt: accepts exactly the canonical decimal string of a positive integer", () =>
  hegel.test((tc) => {
    const n = tc.draw(gs.integers({ minValue: 1, maxValue: Number.MAX_SAFE_INTEGER }));
    const result = parsePositiveInt(String(n), "--x");
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, n);
  }));

test("parsePositiveInt: rejects zero, negatives, and non-canonical text", () =>
  hegel.test((tc) => {
    const kind = tc.draw(gs.sampledFrom(["zero", "negative", "text"] as const));
    if (kind === "zero") {
      assertErr(parsePositiveInt("0", "--x"), "--x must be a positive integer, got '0'");
      return;
    }
    if (kind === "negative") {
      const n = tc.draw(gs.integers({ minValue: 1, maxValue: Number.MAX_SAFE_INTEGER }));
      assertErr(parsePositiveInt(`-${n}`, "--x"), `--x must be a positive integer, got '-${n}'`);
      return;
    }
    // Text that is not the canonical decimal string of any positive
    // integer: full unicode, so this also covers "1.5", "1e3", "+1",
    // "01", leading/trailing whitespace, and empty text.
    const text = tc.draw(gs.text({ maxSize: 10 }));
    const n = Number.parseInt(text, 10);
    const isCanonical = Number.isFinite(n) && n > 0 && String(n) === text;
    tc.assume(!isCanonical);
    assertErr(parsePositiveInt(text, "--x"), "--x must be a positive integer, got");
  }));

test("parsePositiveInt: named non-canonical examples that parseInt still accepts", () => {
  // Number.parseInt("01"/"1.5"/"+1"/"1e3"/" 1"/"1 ", 10) all return a
  // finite positive number, so these specifically exercise the
  // String(n) !== value check on its own -- arbitrary generated text
  // almost never happens to look this number-like by chance.
  for (const text of ["01", "1.5", "+1", "1e3", " 1", "1 "]) {
    assertErr(parsePositiveInt(text, "--x"), `--x must be a positive integer, got '${text}'`);
  }
});
