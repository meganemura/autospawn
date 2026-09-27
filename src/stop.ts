// Responsibility: ask a resident to shut down, or report that none is
// running. Does not know or care what server-command was; stop needs no
// fingerprint, since it is invoked by the same user who could inspect or
// kill the resident by other means anyway.
import fs from "node:fs";
import net from "node:net";
import { baseDir, socketPath } from "./paths.ts";
import { encodeLine, readHeaderLine, type ServerReply } from "./protocol.ts";

export async function stop(name: string): Promise<never> {
  const dir = baseDir();
  const sockPath = socketPath(dir, name);

  const sock = net.connect(sockPath);
  let connectErrorCode: string | undefined;
  const connected = await new Promise<boolean>((resolve) => {
    sock.once("connect", () => resolve(true));
    sock.once("error", (err: NodeJS.ErrnoException) => {
      connectErrorCode = err.code;
      resolve(false);
    });
  });

  if (!connected) {
    try {
      // Stryker disable next-line ConditionalExpression: the surrounding
      // catch below swallows any error unlinkSync throws, including
      // ENOENT when there was never a file to remove -- calling it
      // unconditionally reaches the exact same outcome (still "not
      // running", still exit 0) as gating it on the error code.
      if (connectErrorCode === "ECONNREFUSED") fs.unlinkSync(sockPath);
    } catch {
      // already gone
    }
    process.stderr.write("mcp-autospawn stop: not running\n");
    process.exit(0);
  }

  await new Promise<void>((resolve, reject) => {
    sock.write(encodeLine({ v: 1, op: "stop" }), (err) => (err ? reject(err) : resolve()));
  });
  const reply = (await readHeaderLine(sock)) as ServerReply;
  // Stryker disable next-line CallExpression: both branches below call
  // process.exit() unconditionally right after this, which tears down
  // every open handle (this socket included) at the OS level regardless
  // of whether it was explicitly destroyed first -- no observable
  // difference from outside this process.
  sock.destroy();
  if (reply.ok) {
    process.stderr.write("mcp-autospawn stop: stopped\n");
    process.exit(0);
  }
  process.stderr.write(`mcp-autospawn stop: ${reply.message}\n`);
  process.exit(1);
}
