import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  encodeLine,
  fingerprintArgv,
  HeaderError,
  isAttachHeader,
  isStopHeader,
  MAX_HEADER_BYTES,
  readHeaderLine,
} from "../src/protocol.ts";
import { isDead, makeStateDir, removeStateDir, startServeDirect, waitFor } from "./helpers.ts";

test("header and payload sent in one write are both delivered", async (t) => {
  const dir = makeStateDir();
  const sockPath = path.join(dir, "onewrite.sock");
  const fingerprint = "one-write-fingerprint";
  t.after(() => removeStateDir(dir));

  const serveProc = startServeDirect(sockPath, fingerprint);
  await waitFor(() => fs.existsSync(sockPath), { timeoutMs: 5000 });
  t.after(() => {
    if (!isDead(serveProc.pid!)) serveProc.kill("SIGTERM");
  });

  const sock = net.connect(sockPath);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });

  const header = encodeLine({ v: 1, op: "attach", fingerprint });
  const payload = Buffer.from("one-shot payload\n", "utf8");

  let received = Buffer.alloc(0);
  const gotEverything = new Promise<void>((resolve) => {
    sock.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      // Expect exactly the reply line, then the payload echoed back.
      if (received.length >= Buffer.from('{"ok":true}\n').length + payload.length) {
        resolve();
      }
    });
  });

  // The bug this guards against: readHeaderLine used to unshift bytes back
  // onto the socket while its own "data" listener (and the stream's
  // flowing state) were still live, which is undefined behavior in Node's
  // own streams docs. Sending the header and the payload in a single
  // write is what could trigger that: both arrive in the same "data"
  // event serve's header reader sees.
  sock.write(Buffer.concat([header, payload]));

  await gotEverything;
  const replyLine = '{"ok":true}\n';
  assert.equal(received.subarray(0, replyLine.length).toString("utf8"), replyLine);
  assert.equal(received.subarray(replyLine.length).toString("utf8"), payload.toString("utf8"));

  sock.destroy();
});

// --- Hegel property tests ------------------------------------------------
//
// A single persistent unix-socket listener, reused for every draw of the
// two properties below (chunking, and the encode/read round trip): binding
// and listening happens once; each draw only pays for one connect+accept.

async function makeSocketPairFactory(dir: string): Promise<{
  next(): Promise<{ client: Socket; server: Socket }>;
  close(): void;
}> {
  const sockPath = path.join(dir, "pair.sock");
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(sockPath, resolve));
  return {
    next(): Promise<{ client: Socket; server: Socket }> {
      return new Promise((resolve, reject) => {
        const client = net.connect(sockPath);
        const onError = (err: Error) => reject(err);
        client.once("error", onError);
        srv.once("connection", (server) => {
          client.removeListener("error", onError);
          resolve({ client, server });
        });
      });
    },
    close(): void {
      srv.close();
      try {
        fs.unlinkSync(sockPath);
      } catch {
        // already gone
      }
    },
  };
}

// Splits `full` into a random number of contiguous pieces (including
// possibly-empty ones), at cut points tc draws itself, so hegel can shrink
// both the payload and the chunking.
function drawChunks(tc: hegel.TestCase, full: Buffer): Buffer[] {
  const chunkCount = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
  const cuts: number[] = [];
  for (let i = 0; i < chunkCount - 1; i += 1) {
    cuts.push(tc.draw(gs.integers({ minValue: 0, maxValue: full.length })));
  }
  cuts.sort((a, b) => a - b);
  const bounds = [0, ...cuts, full.length];
  const chunks: Buffer[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    chunks.push(full.subarray(bounds[i]!, bounds[i + 1]!));
  }
  return chunks;
}

async function writeChunks(client: Socket, chunks: Buffer[]): Promise<void> {
  for (const chunk of chunks) {
    await new Promise<void>((resolve, reject) => {
      if (chunk.length === 0) {
        setImmediate(resolve);
        return;
      }
      client.write(chunk, (err) => {
        if (err) reject(err);
        else setImmediate(resolve);
      });
    });
  }
}

async function collectBytes(server: Socket, wantLength: number): Promise<Buffer> {
  if (wantLength === 0) return Buffer.alloc(0);
  let received = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `only received ${received.length} of ${wantLength} tail bytes before timing out`,
        ),
      );
    }, 3000);
    server.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= wantLength) {
        clearTimeout(timer);
        resolve(received);
      }
    });
    server.resume();
  });
}

test("readHeaderLine: header plus a tail split into arbitrary chunks arrives intact and in order", async (t) => {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));
  const pairs = await makeSocketPairFactory(dir);
  t.after(() => pairs.close());

  const headerGen = gs.sampledFrom<Record<string, unknown>>([
    { v: 1, op: "attach", fingerprint: "f" },
    { v: 1, op: "stop" },
  ]);

  await hegel.testAsync(
    async (tc) => {
      const header = tc.draw(headerGen);
      const headerBytes = encodeLine(header);
      // Full unicode/binary tail, including bytes that spell "\n" inside
      // it (not just as a terminator) and the empty tail.
      const tailBytes = Buffer.from(tc.draw(gs.binary({ minSize: 0, maxSize: 200 })));
      const full = Buffer.concat([headerBytes, tailBytes]);
      const chunks = drawChunks(tc, full);

      const { client, server } = await pairs.next();
      try {
        const readPromise = readHeaderLine(server);
        await writeChunks(client, chunks);
        const parsedHeader = await readPromise;
        assert.deepEqual(parsedHeader, header);

        const tail = await collectBytes(server, tailBytes.length);
        assert.equal(Buffer.compare(tail, tailBytes), 0);
      } finally {
        client.destroy();
        server.destroy();
      }
    },
    { testCases: 100 },
  );
});

test("encodeLine -> readHeaderLine round-trips every header shape this protocol sends", async (t) => {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));
  const pairs = await makeSocketPairFactory(dir);
  t.after(() => pairs.close());

  const headerGen = gs.composite<Record<string, unknown>>((tc) => {
    const kind = tc.draw(gs.sampledFrom(["attach", "stop", "ok", "err"] as const));
    if (kind === "attach") {
      return { v: 1, op: "attach", fingerprint: tc.draw(gs.text()) };
    }
    if (kind === "stop") {
      return { v: 1, op: "stop" };
    }
    if (kind === "ok") {
      return { ok: true };
    }
    return { ok: false, error: tc.draw(gs.text()), message: tc.draw(gs.text()) };
  });

  await hegel.testAsync(async (tc) => {
    const header = tc.draw(headerGen);
    const { client, server } = await pairs.next();
    try {
      const readPromise = readHeaderLine(server);
      client.write(encodeLine(header));
      const parsed = await readPromise;
      assert.deepEqual(parsed, header);
    } finally {
      client.destroy();
      server.destroy();
    }
  });
});

test("fingerprintArgv: deterministic, and sensitive to where an element boundary falls", () =>
  hegel.test((tc) => {
    const argv = tc.draw(gs.arrays(gs.text()));
    // Determinism: hashing the same argv twice gives the same fingerprint.
    assert.equal(fingerprintArgv(argv), fingerprintArgv(argv));

    // Splitting one element into two adjacent elements (or the reverse:
    // merging two elements into one) must change JSON.stringify's output,
    // and therefore the fingerprint -- this is the property that makes
    // ["a b"] and ["a", "b"] fingerprint differently, which a naive
    // delimiter-joined fingerprint (argv.join(" ")) would get wrong.
    if (argv.length > 0) {
      const idx = tc.draw(gs.integers({ minValue: 0, maxValue: argv.length - 1 }));
      const element = argv[idx]!;
      if (element.length > 0) {
        const splitAt = tc.draw(gs.integers({ minValue: 0, maxValue: element.length }));
        const split = [
          ...argv.slice(0, idx),
          element.slice(0, splitAt),
          element.slice(splitAt),
          ...argv.slice(idx + 1),
        ];
        assert.notEqual(fingerprintArgv(argv), fingerprintArgv(split));
      }
    }
  }));

test("fingerprintArgv: named boundary examples", () => {
  assert.notEqual(fingerprintArgv(["a b"]), fingerprintArgv(["a", "b"]));
  assert.notEqual(fingerprintArgv(["ab"]), fingerprintArgv(["a", "b"]));
});

// --- Unit tests added from mutation-testing survivors ---------------------
//
// Each test below exists because a Stryker mutant on readHeaderLine
// survived the property tests above: they exercise readHeaderLine's error
// paths and its cleanup, which no property test above reaches.

async function connectedPair(dir: string): Promise<{ client: Socket; server: Socket }> {
  const sockPath = path.join(dir, `pair-${Math.random().toString(36).slice(2)}.sock`);
  const srv = net.createServer();
  await new Promise<void>((resolve) => srv.listen(sockPath, resolve));
  const pair = await new Promise<{ client: Socket; server: Socket }>((resolve, reject) => {
    const client = net.connect(sockPath);
    client.once("error", reject);
    srv.once("connection", (server) => resolve({ client, server }));
  });
  srv.close();
  return pair;
}

test("readHeaderLine: removes its own listeners once it resolves successfully", async (t) => {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));
  const { client, server } = await connectedPair(dir);
  t.after(() => {
    client.destroy();
    server.destroy();
  });

  const readPromise = readHeaderLine(server);
  client.write(encodeLine({ v: 1, op: "stop" }));
  await readPromise;

  // If readHeaderLine's cleanup did not run, one of these listeners (its
  // own onData/onError/onClose) would still be attached, and would go on
  // to double-process whatever the real relay listener the caller attaches
  // next also receives.
  assert.equal(server.listenerCount("data"), 0);
  assert.equal(server.listenerCount("error"), 0);
  assert.equal(server.listenerCount("close"), 0);
});

test("readHeaderLine: a header line longer than the size limit is rejected, exactly at the boundary", async (t) => {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));

  {
    const { client, server } = await connectedPair(dir);
    t.after(() => {
      client.destroy();
      server.destroy();
    });
    // Exactly MAX_HEADER_BYTES, no newline yet: must not be rejected as
    // too large (the check is a strict ">", not ">=").
    const readPromise = readHeaderLine(server, { timeoutMs: 200 });
    client.write("x".repeat(MAX_HEADER_BYTES));
    const err = await readPromise.catch((e: unknown) => e as HeaderError);
    assert.ok(err instanceof HeaderError);
    assert.equal(err.code, "header_timeout");
    assert.equal(err.message, "header not received in time");
  }

  {
    const { client, server } = await connectedPair(dir);
    t.after(() => {
      client.destroy();
      server.destroy();
    });
    // One byte past the limit, still no newline: must be rejected as too
    // large, well before any timeout.
    const readPromise = readHeaderLine(server, { timeoutMs: 5000 });
    client.write("x".repeat(MAX_HEADER_BYTES + 1));
    const err = await readPromise.catch((e: unknown) => e as HeaderError);
    assert.ok(err instanceof HeaderError);
    assert.equal(err.code, "header_too_large");
    assert.equal(err.message, "header exceeded size limit");
  }
});

test("readHeaderLine: a header line that is not valid JSON rejects with header_invalid", async (t) => {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));
  const { client, server } = await connectedPair(dir);
  t.after(() => {
    client.destroy();
    server.destroy();
  });

  const readPromise = readHeaderLine(server);
  client.write("not-json-at-all\n");
  const err = await readPromise.catch((e: unknown) => e as HeaderError);
  assert.ok(err instanceof HeaderError);
  assert.equal(err.code, "header_invalid");
  assert.equal(err.message, "header line is not valid JSON");
});

test("readHeaderLine: an 'error' event on the socket rejects the pending read and cleans up", async (t) => {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));
  const { client, server } = await connectedPair(dir);
  t.after(() => {
    client.destroy();
    server.destroy();
  });

  const readPromise = readHeaderLine(server);
  server.emit("error", new Error("synthetic socket error"));
  await assert.rejects(readPromise, /synthetic socket error/);

  // finish()'s own cleanup() call must have run too, not only the one on
  // the success path tested above.
  assert.equal(server.listenerCount("data"), 0);
  assert.equal(server.listenerCount("error"), 0);
  assert.equal(server.listenerCount("close"), 0);
});

test("readHeaderLine: the socket closing before a header arrives rejects with header_closed", async (t) => {
  const dir = makeStateDir();
  t.after(() => removeStateDir(dir));
  const { client, server } = await connectedPair(dir);
  t.after(() => {
    client.destroy();
    server.destroy();
  });

  const readPromise = readHeaderLine(server);
  client.destroy();
  const err = await readPromise.catch((e: unknown) => e as HeaderError);
  assert.ok(err instanceof HeaderError);
  assert.equal(err.code, "header_closed");
  assert.equal(err.message, "socket closed before header");
});

// isAttachHeader/isStopHeader are only called from serve.ts, which every
// other test in this project exercises as a subprocess -- invisible to
// Stryker's coverage analysis (see the mutation-testing report). Calling
// them directly here is what gives their mutants any coverage at all.
const wellFormedAttach = gs.record({
  v: gs.just(1 as const),
  op: gs.just("attach" as const),
  fingerprint: gs.text(),
});
const wellFormedStop = gs.record({ v: gs.just(1 as const), op: gs.just("stop" as const) });

test("isAttachHeader / isStopHeader: accept exactly their own well-formed shape", () =>
  hegel.test((tc) => {
    const kind = tc.draw(gs.sampledFrom(["attach", "stop"] as const));
    if (kind === "attach") {
      const header = tc.draw(wellFormedAttach);
      assert.equal(isAttachHeader(header), true);
      assert.equal(isStopHeader(header), false);
    } else {
      const header = tc.draw(wellFormedStop);
      assert.equal(isAttachHeader(header), false);
      assert.equal(isStopHeader(header), true);
    }
  }));

test("isAttachHeader / isStopHeader: named malformed-shape examples", () => {
  const cases: Array<[unknown, boolean, boolean]> = [
    // [value, expectAttach, expectStop]
    [null, false, false],
    [undefined, false, false],
    ["attach", false, false],
    [42, false, false],
    [[], false, false],
    [{}, false, false],
    [{ v: 1, op: "attach" }, false, false], // fingerprint missing
    [{ v: 1, op: "attach", fingerprint: 42 }, false, false], // fingerprint wrong type
    [{ v: 2, op: "attach", fingerprint: "f" }, false, false], // wrong v
    [{ v: 1, op: "ATTACH", fingerprint: "f" }, false, false], // wrong case
    [{ v: 1, op: "stop", extra: true }, false, true], // extra field is fine
    [{ v: 2, op: "stop" }, false, false], // wrong v
  ];
  for (const [bad, expectAttach, expectStop] of cases) {
    assert.equal(isAttachHeader(bad), expectAttach, JSON.stringify(bad));
    assert.equal(isStopHeader(bad), expectStop, JSON.stringify(bad));
  }
});
