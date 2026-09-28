import test from "node:test";
import assert from "node:assert/strict";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  encodeExit,
  encodeFrame,
  exitCodeFor,
  FRAME_EXIT,
  FrameDecoder,
  FrameError,
  MAX_FRAME_PAYLOAD,
  parseExit,
} from "../src/frames.ts";

test("FrameDecoder: frames split at any points come back whole and in order", () =>
  hegel.test((tc) => {
    const frames = tc.draw(
      gs.arrays(gs.tuples(gs.integers({ minValue: 0, maxValue: 255 }), gs.binary({ maxSize: 64 })), { maxSize: 8 }),
    );
    const stream = Buffer.concat(frames.map(([type, payload]) => encodeFrame(type, Buffer.from(payload))));
    // Cut the stream at drawn points, including the ends and repeats.
    const cuts = tc
      .draw(gs.arrays(gs.integers({ minValue: 0, maxValue: stream.length }), { maxSize: 10 }))
      .sort((a, b) => a - b);
    const decoder = new FrameDecoder();
    const out: [number, Buffer][] = [];
    let from = 0;
    for (const to of [...cuts, stream.length]) {
      for (const frame of decoder.push(stream.subarray(from, to))) out.push([frame.type, frame.payload]);
      from = to;
    }
    assert.equal(decoder.pending, 0);
    assert.deepEqual(
      out.map(([type, payload]) => [type, [...payload]]),
      frames.map(([type, payload]) => [type, [...payload]]),
    );
  }));

test("FrameDecoder: a length over the limit is refused before any payload arrives", () => {
  const header = Buffer.alloc(5);
  header.writeUInt8(1, 0);
  header.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 1);
  assert.throws(() => new FrameDecoder().push(header), FrameError);
  header.writeUInt32BE(MAX_FRAME_PAYLOAD, 1);
  assert.deepEqual(new FrameDecoder().push(header), []);
});

test("exit frames carry a code or a signal, and parse back", () => {
  const decoder = new FrameDecoder();
  const [frame] = decoder.push(encodeExit({ code: 3, signal: null }));
  assert.equal(frame!.type, FRAME_EXIT);
  assert.deepEqual(parseExit(frame!.payload), { code: 3, signal: null });
  assert.deepEqual(parseExit(Buffer.from('{"code":null,"signal":"SIGTERM"}')), { code: null, signal: "SIGTERM" });
  for (const bad of ["[]", "null", '{"code":"3","signal":null}', '{"code":1.5,"signal":null}', '{"code":null,"signal":9}']) {
    assert.throws(() => parseExit(Buffer.from(bad)), FrameError, bad);
  }
});

test("exitCodeFor: the child's code, 128 plus a signal's number, and 1 otherwise", () => {
  for (const code of [0, 1, 3, 127, 255]) assert.equal(exitCodeFor({ code, signal: null }), code);
  assert.equal(exitCodeFor({ code: null, signal: "SIGTERM" }), 143);
  assert.equal(exitCodeFor({ code: null, signal: "SIGKILL" }), 137);
  assert.equal(exitCodeFor({ code: null, signal: "SIGNOPE" }), 1);
  assert.equal(exitCodeFor({ code: null, signal: null }), 1);
  assert.equal(exitCodeFor({ code: 256, signal: null }), 1);
  assert.equal(exitCodeFor({ code: -2, signal: null }), 1);
});
