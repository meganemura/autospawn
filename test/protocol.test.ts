import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { encodeLine } from "../src/protocol.ts";
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
