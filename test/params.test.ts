import test from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { takeRepeated } from "../src/args.ts";
import {
  checkServeArgsCommand,
  childParamEnv,
  MAX_VALUE_BYTES,
  parseConnectParams,
  parseServeArgs,
  parseServeParams,
  resolveDeclaredArgs,
  substituteServerCommand,
  valueError,
} from "../src/params.ts";
import { isAttachHeader } from "../src/protocol.ts";

// An independent statement of the value rule, to check valueError against.
function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

test("valueError: a value is refused exactly when it holds a control character or passes the size limit", () =>
  hegel.test((tc) => {
    const value = tc.draw(gs.text({ maxSize: 40 }));
    const expectRefused = hasControlChar(value) || Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES;
    assert.equal(valueError("k", value) !== null, expectRefused, JSON.stringify(value));
  }));

test("valueError: the size limit is on bytes, at exactly 4096", () => {
  assert.equal(valueError("k", "a".repeat(4096)), null);
  assert.notEqual(valueError("k", "a".repeat(4097)), null);
  // Three bytes each in UTF-8: 1365 fit, 1366 do not.
  assert.equal(valueError("k", "あ".repeat(1365)), null);
  assert.notEqual(valueError("k", "あ".repeat(1366)), null);
});

test("parseConnectParams: key=value pairs become a record, and the value may hold '='", () => {
  assert.deepEqual(parseConnectParams(["topic=proj-a", "expr=a=b"]), {
    ok: true,
    value: { topic: "proj-a", expr: "a=b" },
  });
  assert.deepEqual(parseConnectParams([]), { ok: true, value: {} });
  assert.deepEqual(parseConnectParams(["empty="]), { ok: true, value: { empty: "" } });
});

test("parseConnectParams: refuses a missing '=', a bad key, a bad value, and a repeated key", () => {
  for (const pairs of [["topic"], ["Topic=x"], ["1topic=x"], ["topic=a\nb"], ["topic=x", "topic=y"]]) {
    assert.equal(parseConnectParams(pairs).ok, false, JSON.stringify(pairs));
  }
});

test("parseServeParams: maps keys to variable names that the environment does not already hold", () => {
  assert.deepEqual(parseServeParams(["topic=PROBE_TOPIC", "mode=probe_mode"], {}), {
    ok: true,
    value: { topic: "PROBE_TOPIC", mode: "probe_mode" },
  });
});

test("parseServeParams: refuses bad names, autospawn's own names, set names, and duplicates", () => {
  const cases: [string[], NodeJS.ProcessEnv, RegExp][] = [
    [["topic"], {}, /not key=ENV_NAME/],
    [["topic=1BAD"], {}, /invalid environment variable name/],
    [["topic=AUTOSPAWN_TOPIC"], {}, /belong to autospawn/],
    [["url=API_URL"], { API_URL: "https://api.example.com" }, /already set/],
    [["topic=A", "topic=B"], {}, /declared twice/],
    [["a=SAME", "b=SAME"], {}, /two parameters/],
    [["Bad=X"], {}, /invalid parameter name/],
  ];
  for (const [pairs, env, pattern] of cases) {
    const result = parseServeParams(pairs, env);
    assert.equal(result.ok, false, JSON.stringify(pairs));
    if (!result.ok) assert.match(result.error, pattern);
  }
});

test("childParamEnv: declared keys become their variables; an undeclared key or a bad value is refused", () => {
  const declared = { topic: "PROBE_TOPIC" };
  assert.deepEqual(childParamEnv({ topic: "proj-a" }, declared), {
    ok: true,
    value: { PROBE_TOPIC: "proj-a" },
  });
  assert.deepEqual(childParamEnv({}, declared), { ok: true, value: {} });
  const undeclared = childParamEnv({ other: "x" }, declared);
  assert.equal(undeclared.ok, false);
  if (!undeclared.ok) assert.match(undeclared.error, /not declared/);
  assert.equal(childParamEnv({ topic: "a\u0000b" }, declared).ok, false);
});

test("takeRepeated: takes every flag pair in order and leaves the rest, even a value equal to the flag", () => {
  assert.deepEqual(takeRepeated(["--param", "a=1", "--name", "x", "--param", "b=2"], "--param"), {
    ok: true,
    value: { rest: ["--name", "x"], values: ["a=1", "b=2"] },
  });
  assert.deepEqual(takeRepeated(["--name", "--param"], "--param"), {
    ok: true,
    value: { rest: ["--name", "--param"], values: [] },
  });
  assert.equal(takeRepeated(["--param"], "--param").ok, false);
});

test("isAttachHeader: params is optional, and must map strings to strings when present", () => {
  const base = { v: 1, op: "attach", fingerprint: "f" };
  assert.equal(isAttachHeader(base), true);
  assert.equal(isAttachHeader({ ...base, params: { topic: "x" } }), true);
  assert.equal(isAttachHeader({ ...base, params: { topic: 1 } }), false);
  assert.equal(isAttachHeader({ ...base, params: ["x"] }), false);
  assert.equal(isAttachHeader({ ...base, params: null }), false);
});

test("parameter names are checked over their whole length, not only a prefix", () => {
  assert.equal(parseConnectParams(["topic!=x"]).ok, false);
  assert.equal(parseConnectParams(["topic x=x"]).ok, false);
  assert.equal(parseServeParams(["topic=EXAMPLE-TOPIC"], {}).ok, false);
  assert.equal(parseServeParams(["topic=EXAMPLE TOPIC"], {}).ok, false);
});

test("parameter errors say what is wrong", () => {
  const cases: [ReturnType<typeof parseConnectParams>, RegExp][] = [
    [parseConnectParams(["topic"]), /^--param 'topic' is not key=value$/],
    [parseConnectParams(["topic=a", "topic=b"]), /^--param 'topic' is given twice$/],
    [parseConnectParams([`topic=${"a".repeat(4097)}`]), /^parameter 'topic' is longer than 4096 bytes$/],
  ];
  for (const [result, pattern] of cases) {
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, pattern);
  }
  const missing = takeRepeated(["--param"], "--param");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error, "option '--param' needs a value");
});

test("isAttachHeader: params that are not an object of strings are refused", () => {
  const base = { v: 1, op: "attach", fingerprint: "f" };
  assert.equal(isAttachHeader({ ...base, params: "topic" }), false);
  assert.equal(isAttachHeader({ ...base, params: 5 }), false);
  assert.equal(isAttachHeader({ ...base, params: { a: "x", b: 1 } }), false);
});

// --arg (ADR 0010): serve declares a key and an enumerated set of values;
// an attach picks one of them, and it lands in the server command's argv,
// not the environment.

test("parseServeArgs: splits each declaration's values on ','", () => {
  assert.deepEqual(parseServeArgs(["event=stop,session-start", "host=claude"], {}), {
    ok: true,
    value: { event: ["stop", "session-start"], host: ["claude"] },
  });
});

test("parseServeArgs: refuses a bad key, an empty value, a duplicate value, a key declared twice, and a key --param already declared", () => {
  const cases: [string[], Record<string, string>, RegExp][] = [
    [["Bad=x"], {}, /invalid parameter name/],
    [["event"], {}, /not key=value/],
    [["event="], {}, /empty value/],
    [["event=stop,"], {}, /empty value/],
    [["event=stop,stop"], {}, /lists the value 'stop' twice/],
    [["event=stop", "event=cont"], {}, /declared twice/],
    [["event=stop"], { event: "EVENT" }, /already declared by --param/],
  ];
  for (const [pairs, declaredParams, pattern] of cases) {
    const result = parseServeArgs(pairs, declaredParams);
    assert.equal(result.ok, false, JSON.stringify(pairs));
    if (!result.ok) assert.match(result.error, pattern);
  }
});

test("parseServeArgs: a value with a control character or over 4096 bytes fails the same valueError check --param uses", () => {
  assert.equal(parseServeArgs(["event=a\u0001b"], {}).ok, false);
  assert.equal(parseServeArgs([`event=${"a".repeat(4097)}`], {}).ok, false);
});

test("checkServeArgsCommand: refuses a declared key in the command itself, and one absent from the rest", () => {
  const declared = { event: ["stop", "session-start"] };
  assert.deepEqual(checkServeArgsCommand(declared, ["tool", "{event}"]), { ok: true, value: true });
  const inCommand = checkServeArgsCommand(declared, ["{event}", "hook"]);
  assert.equal(inCommand.ok, false);
  if (!inCommand.ok) assert.match(inCommand.error, /server command's first word/);
  const missing = checkServeArgsCommand(declared, ["tool", "hook"]);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /does not appear in the server command/);
});

test("checkServeArgsCommand: a key used more than once, or alongside literal text in one token, is still found", () => {
  const declared = { event: ["stop"] };
  assert.equal(checkServeArgsCommand(declared, ["tool", "--flag={event}"]).ok, true);
  assert.equal(checkServeArgsCommand(declared, ["tool", "{event}", "{event}"]).ok, true);
});

test("resolveDeclaredArgs: a value in the enumeration resolves; a missing key is required; an unlisted value is refused", () => {
  const declared = { event: ["stop", "session-start"] };
  assert.deepEqual(resolveDeclaredArgs({ event: "stop" }, declared), { ok: true, value: { event: "stop" } });
  const missing = resolveDeclaredArgs({}, declared);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /'event' is required/);
  const unlisted = resolveDeclaredArgs({ event: "other" }, declared);
  assert.equal(unlisted.ok, false);
  if (!unlisted.ok) assert.match(unlisted.error, /'event' is not one of its declared values/);
});

test("resolveDeclaredArgs: a value is accepted exactly when it is a member of its key's enumeration", () =>
  hegel.test((tc) => {
    const enumeration = tc.draw(gs.arrays(gs.sampledFrom(["a", "b", "c", "d"]), { minSize: 1, maxSize: 4 }));
    const declared = { k: enumeration };
    const candidate = tc.draw(gs.sampledFrom(["a", "b", "c", "d", "e"]));
    const result = resolveDeclaredArgs({ k: candidate }, declared);
    assert.equal(result.ok, enumeration.includes(candidate), JSON.stringify({ enumeration, candidate }));
  }));

test("substituteServerCommand: replaces a declared key everywhere it appears, and leaves an undeclared '{...}' untouched", () => {
  assert.deepEqual(
    substituteServerCommand(["tool", "{event}", "--host={host}", "{unknown}"], { event: "stop", host: "claude" }),
    ["tool", "stop", "--host=claude", "{unknown}"],
  );
});

test("substituteServerCommand: several keys, or one key twice, in a single token all resolve", () => {
  assert.deepEqual(substituteServerCommand(["{a}-{b}", "{a}{a}"], { a: "x", b: "y" }), ["x-y", "xx"]);
});

test("substituteServerCommand: a value with a space stays inside its own argv element", () => {
  assert.deepEqual(substituteServerCommand(["tool", "{note}"], { note: "one two" }), ["tool", "one two"]);
});

test("substituteServerCommand: one pass -- a value that looks like another placeholder is not substituted again", () => {
  assert.deepEqual(substituteServerCommand(["{a}"], { a: "{b}", b: "x" }), ["{b}"]);
});

test("substituteServerCommand: token count and non-placeholder tokens are unchanged", () =>
  hegel.test((tc) => {
    const values = tc.draw(gs.record({ k: gs.sampledFrom(["a", "b", "c"]) }));
    const tokens = tc.draw(gs.arrays(gs.sampledFrom(["{k}", "plain", "--flag={k}"]), { minSize: 0, maxSize: 5 }));
    const out = substituteServerCommand(tokens, values);
    assert.equal(out.length, tokens.length);
    for (const [i, token] of tokens.entries()) {
      if (token === "plain") assert.equal(out[i], "plain");
    }
  }));
