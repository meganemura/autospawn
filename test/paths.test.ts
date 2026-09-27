import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  baseDir,
  ensureBaseDir,
  logPath,
  PathError,
  socketPath,
  spawnLockPath,
  validateName,
} from "../src/paths.ts";

test("logPath / spawnLockPath: named suffix examples", () => {
  assert.equal(logPath("/base", "example"), "/base/example.log");
  assert.equal(spawnLockPath("/base", "example"), "/base/example.spawn");
});

test("baseDir: AUTOSPAWN_DIR wins when set and non-empty; otherwise falls back to $HOME", () =>
  hegel.test((tc) => {
    const useOverride = tc.draw(gs.booleans());
    if (useOverride) {
      const dir = tc.draw(gs.text({ minSize: 1, maxSize: 20 }));
      assert.equal(baseDir({ AUTOSPAWN_DIR: dir }), dir);
      return;
    }
    const home = tc.draw(gs.text({ minSize: 1, maxSize: 20 }));
    // An empty-string override must be treated the same as unset, not
    // used literally.
    const env = tc.draw(gs.booleans())
      ? { HOME: home }
      : { HOME: home, AUTOSPAWN_DIR: "" };
    assert.equal(baseDir(env), path.join(home, ".local", "state", "autospawn"));
  }));

// Independent oracle, written from the documented contract
// (`^[A-Za-z0-9._-]+$`, and not starting with `.`) rather than by
// importing paths.ts's own pattern.
const DOCUMENTED_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function isDocumentedValidName(name: string): boolean {
  return DOCUMENTED_NAME_PATTERN.test(name) && !name.startsWith(".");
}

// Half arbitrary unicode text (almost always invalid: the interesting
// case for the "rejects" side), half built from the valid alphabet itself
// (so the "accepts" branch actually fires and isn't just a guard that
// never runs), and sometimes forced to start with "." to exercise that
// specific rejection independently of the character-class check.
const nameCandidateGen = gs.composite<string>((tc) => {
  const base = tc.draw(gs.booleans())
    ? tc.draw(gs.fromRegex("[A-Za-z0-9._-]{1,20}"))
    : tc.draw(gs.text({ maxSize: 20 }));
  return tc.draw(gs.booleans()) ? `.${base}` : base;
});

test("validateName: accepts exactly the strings the documented pattern accepts", () =>
  hegel.test((tc) => {
    const name = tc.draw(nameCandidateGen);
    const expectedValid = isDocumentedValidName(name);
    if (expectedValid) {
      assert.doesNotThrow(() => validateName(name));
    } else {
      assert.throws(() => validateName(name), PathError);
      try {
        validateName(name);
      } catch (err) {
        assert.match((err as PathError).message, new RegExp(`'${escapeRegExp(name)}'`));
      }
    }
  }));

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("validateName: named boundary examples", () => {
  assert.doesNotThrow(() => validateName("a"));
  assert.doesNotThrow(() => validateName("a.b-c_9"));
  assert.throws(() => validateName(".hidden"), PathError);
  assert.throws(() => validateName(""), PathError);
  assert.throws(() => validateName("has space"), PathError);
  assert.throws(() => validateName("has/slash"), PathError);
});

// Builds a dir string of exactly `targetBytes` UTF-8 bytes, containing one
// multibyte marker character plus single-byte filler -- targeting the
// byte-length boundary specifically (rather than a character-count
// boundary, which is the bug this check exists to avoid: a naive
// `name.length <= 103` would accept a path that is actually over the
// socket limit once multibyte characters are encoded).
function buildDirOfByteLength(targetBytes: number, marker: string): string {
  const markerBytes = Buffer.byteLength(marker, "utf8");
  return marker + "a".repeat(Math.max(0, targetBytes - markerBytes));
}

const MULTIBYTE_MARKERS = ["é", "あ", "😀"]; // "é", "あ", "😀"

test("socketPath: passes at exactly 103 bytes, throws PathError at 104+, for dirs containing multibyte characters", () =>
  hegel.test((tc) => {
    const marker = tc.draw(gs.sampledFrom(MULTIBYTE_MARKERS));
    const offset = tc.draw(gs.integers({ minValue: -5, maxValue: 5 }));
    const fullTarget = 103 + offset;
    const name = "n"; // fixed: "/n.sock" is 7 bytes, so dir's own byte
    // length can be computed exactly from fullTarget.
    const suffixBytes = Buffer.byteLength(`/${name}.sock`, "utf8");
    const dirTarget = fullTarget - suffixBytes;
    tc.assume(dirTarget >= Buffer.byteLength(marker, "utf8"));

    const dir = buildDirOfByteLength(dirTarget, marker);
    const fullPath = `${dir}/${name}.sock`;
    // Sanity check on the construction itself, independent of socketPath.
    assert.equal(Buffer.byteLength(fullPath, "utf8"), fullTarget);

    if (fullTarget <= 103) {
      assert.equal(socketPath(dir, name), fullPath);
    } else {
      assert.throws(() => socketPath(dir, name), PathError);
      try {
        socketPath(dir, name);
        assert.fail("expected socketPath to throw");
      } catch (err) {
        assert.match((err as PathError).message, /socket path is too long/);
        assert.match((err as PathError).message, /AUTOSPAWN_DIR/);
      }
    }
  }));

test("socketPath: named boundary examples at exactly 103 and 104 bytes", () => {
  const marker = "あ"; // "あ", 3 bytes
  const name = "n";
  const suffixBytes = Buffer.byteLength(`/${name}.sock`, "utf8");

  const dir103 = buildDirOfByteLength(103 - suffixBytes, marker);
  const path103 = `${dir103}/${name}.sock`;
  assert.equal(Buffer.byteLength(path103, "utf8"), 103);
  assert.doesNotThrow(() => socketPath(dir103, name));

  const dir104 = buildDirOfByteLength(104 - suffixBytes, marker);
  const path104 = `${dir104}/${name}.sock`;
  assert.equal(Buffer.byteLength(path104, "utf8"), 104);
  assert.throws(() => socketPath(dir104, name), PathError);
});

// ensureBaseDir is called by connect and serve, but every test elsewhere
// in this project exercises it as a subprocess (invisible to Stryker's
// coverage analysis; see the mutation-testing report). It does only fs
// syscalls, so it is easy to call directly here in-process.
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mas-paths-"));
}

test("ensureBaseDir: creates a missing directory with mode 0700", () => {
  const parent = makeTmpDir();
  const dir = path.join(parent, "state");
  try {
    assert.equal(fs.existsSync(dir), false);
    ensureBaseDir(dir);
    const stat = fs.statSync(dir);
    assert.equal(stat.mode & 0o777, 0o700);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureBaseDir: accepts an existing directory already at mode 0700", () => {
  const parent = makeTmpDir();
  try {
    fs.chmodSync(parent, 0o700);
    assert.doesNotThrow(() => ensureBaseDir(parent));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureBaseDir: refuses a directory open to group or other, naming the fix", () => {
  const parent = makeTmpDir();
  try {
    fs.chmodSync(parent, 0o755);
    assert.throws(() => ensureBaseDir(parent), PathError);
    try {
      ensureBaseDir(parent);
      assert.fail("expected ensureBaseDir to throw");
    } catch (err) {
      assert.match((err as PathError).message, /accessible to group or other/);
      assert.match((err as PathError).message, new RegExp(`chmod 700 ${escapeRegExp(parent)}`));
    }
  } finally {
    fs.chmodSync(parent, 0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureBaseDir: creates every missing intermediate directory, not just the last one", () => {
  const parent = makeTmpDir();
  const dir = path.join(parent, "a", "b", "state");
  try {
    ensureBaseDir(dir);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureBaseDir: a stat failure that is not ENOENT propagates instead of being treated as missing", () => {
  const parent = makeTmpDir();
  try {
    // parent/notadir is a plain file, so stat("parent/notadir/state")
    // fails with ENOTDIR, not ENOENT.
    const notADir = path.join(parent, "notadir");
    fs.writeFileSync(notADir, "");
    const dir = path.join(notADir, "state");
    assert.throws(() => ensureBaseDir(dir), (err: unknown) => {
      return (err as NodeJS.ErrnoException).code === "ENOTDIR";
    });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("ensureBaseDir: a non-ENOENT stat failure is the exact error rethrown, not treated as missing", (t) => {
  // A stronger version of the ENOTDIR test above: if the ENOENT check
  // were replaced with "always treat as missing", ensureBaseDir would
  // call mkdirSync/chmodSync on this already-existing, already-correct
  // directory instead -- both succeed silently on an existing 0700 dir,
  // so it would return normally instead of throwing. Mocking statSync to
  // throw a distinguishable fake error, and asserting that exact object
  // comes back out, is what tells the two branches apart when both real
  // filesystem calls would otherwise succeed either way.
  const dir = makeTmpDir();
  fs.chmodSync(dir, 0o700);
  const fakeError = Object.assign(new Error("synthetic stat failure"), { code: "EACCES" });
  t.mock.method(fs, "statSync", () => {
    throw fakeError;
  });
  try {
    assert.throws(() => ensureBaseDir(dir), (err: unknown) => err === fakeError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
