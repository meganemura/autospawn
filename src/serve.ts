// Responsibility: listen on the resident's socket, hand each connection its
// own copy of server-command over stdio, and relay bytes between them.
//
// Not done here: opening a log file. The chain that started this process
// (spawn-chain.ts) already redirected its own stdout/stderr to the log file
// descriptor before exec'ing into whatever ends up running this serve
// command (typically a secrets wrapper). If serve opened the log file
// itself, an 1Password-masking wrapper further up the chain would have
// nothing to mask, since its own stdout/stderr redirection is what applies
// the mask. So serve writes its own diagnostics, and the child's stderr,
// to its own stderr, and never touches the log path.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { ensureBaseDir } from "./paths.ts";
import {
  encodeLine,
  isAttachHeader,
  isStopHeader,
  readHeaderLine,
  type ErrReply,
} from "./protocol.ts";

function logLine(message: string): void {
  process.stderr.write(`${new Date().toISOString()} [serve] ${message}\n`);
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AUTOSPAWN_")) delete env[key];
  }
  return env;
}

type Ownership = { dev: number; ino: number };

function statOwnership(sockPath: string): Ownership | null {
  try {
    const st = fs.statSync(sockPath);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

function sameOwnership(a: Ownership, b: Ownership | null): boolean {
  if (b === null) return false;
  // Stryker disable next-line ConditionalExpression: the socket and its
  // replacement live in the same directory, so they share a device and
  // only the inode can differ. dev guards a case no test can build: a
  // filesystem mounted over the state directory between two checks.
  const sameDevice = a.dev === b.dev;
  return sameDevice && a.ino === b.ino;
}

function requireSocket(): never {
  process.stderr.write(
    "autospawn serve: AUTOSPAWN_SOCKET is not set; serve must be " +
      "started by 'autospawn connect', not run directly\n",
  );
  process.exit(2);
}

export async function serve(
  idleTimeoutSeconds: number | null,
  serverCommand: readonly string[],
): Promise<never> {
  const sockPath: string = process.env.AUTOSPAWN_SOCKET ?? requireSocket();
  const fingerprint = process.env.AUTOSPAWN_FINGERPRINT ?? "";
  ensureBaseDir(path.dirname(sockPath));

  const children = new Set<ChildProcess>();
  let ownership: Ownership | null = null;
  let raceLost = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  const server = net.createServer({ allowHalfOpen: true });

  function scheduleIdleCheck(): void {
    if (idleTimeoutSeconds === null) return;
    if (idleTimer) clearTimeout(idleTimer);
    if (children.size > 0) return;
    idleTimer = setTimeout(() => {
      if (children.size === 0) {
        logLine(`idle for ${idleTimeoutSeconds}s, stopping`);
        void shutdownOwned();
      }
    }, idleTimeoutSeconds * 1000);
  }

  function checkOwnership(): void {
    if (raceLost || ownership === null) return;
    const current = statOwnership(sockPath);
    if (!sameOwnership(ownership, current)) {
      raceLost = true;
      logLine("lost ownership of the socket path to another resident; draining");
      if (children.size === 0) exitWithoutUnlink();
    }
  }

  function exitWithoutUnlink(): never {
    // The path now belongs to another resident's socket; calling
    // server.close() here would unlink that resident's file (verified: a
    // net.Server unlinks whatever currently sits at its bind path on
    // close(), even if it is no longer this server's own file). Exiting
    // directly leaves the path untouched.
    process.exit(0);
  }

  function shutdownOwned(): Promise<never> {
    if (shuttingDown) return new Promise<never>(() => {});
    shuttingDown = true;
    for (const child of children) child.kill("SIGTERM");
    return new Promise<never>(() => {
      server.close(() => {
        process.exit(0);
      });
    });
  }

  server.on("connection", (socket: Socket) => {
    checkOwnership();
    if (raceLost || shuttingDown) {
      socket.destroy();
      return;
    }
    handleConnection(socket).catch(() => socket.destroy());
  });

  async function handleConnection(socket: Socket): Promise<void> {
    let header: unknown;
    try {
      header = await readHeaderLine(socket);
    } catch {
      socket.destroy();
      return;
    }

    if (isStopHeader(header)) {
      await writeLine(socket, { ok: true });
      socket.end();
      await shutdownOwned();
      return;
    }

    if (!isAttachHeader(header)) {
      await writeLine(socket, errReply("bad_header", "expected attach or stop"));
      socket.destroy();
      return;
    }

    if (header.fingerprint !== fingerprint) {
      await writeLine(socket, errReply("fingerprint_mismatch", "spawn command does not match"));
      socket.destroy();
      return;
    }

    await writeLine(socket, { ok: true });
    spawnChild(socket);
    // readHeaderLine paused the socket once it found the header line;
    // spawnChild has now attached the relay listeners, so it is safe to
    // let bytes flow again.
    socket.resume();
  }

  function spawnChild(socket: Socket): void {
    const [cmd, ...args] = serverCommand;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    let child: ChildProcess;
    try {
      child = spawn(cmd!, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv(),
      });
    } catch (err) {
      logLine(`failed to spawn server-command: ${(err as Error).message}`);
      socket.destroy();
      return;
    }
    children.add(child);

    child.on("error", (err) => {
      logLine(`server-command error: ${err.message}`);
      socket.destroy();
    });

    child.stdout!.on("data", (chunk: Buffer) => socket.write(chunk));
    child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.stdin!.on("error", () => {});

    socket.on("data", (chunk: Buffer) => child.stdin!.write(chunk));
    socket.on("end", () => child.stdin!.end());
    socket.on("close", () => child.kill("SIGTERM"));
    socket.on("error", () => child.kill("SIGTERM"));

    child.on("close", () => {
      children.delete(child);
      socket.end();
      if (raceLost && children.size === 0) {
        exitWithoutUnlink();
        return;
      }
      scheduleIdleCheck();
    });
  }

  function writeLine(socket: Socket, obj: unknown): Promise<void> {
    return new Promise((resolve) => {
      socket.write(encodeLine(obj), () => resolve());
    });
  }

  function errReply(error: string, message: string): ErrReply {
    return { ok: false, error, message };
  }

  await bindListener(server, sockPath);
  fs.chmodSync(sockPath, 0o600);
  ownership = statOwnership(sockPath);
  scheduleIdleCheck();
  const ownershipTimer = setInterval(checkOwnership, 1000);
  ownershipTimer.unref?.();

  const onSignal = () => {
    if (raceLost) exitWithoutUnlink();
    void shutdownOwned();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  return new Promise<never>(() => {});
}

// Binds sockPath, recovering from a stale socket file left by a resident
// that died without cleaning up. If another resident is actually listening,
// logs and exits 0 instead of stealing the path.
function bindListener(server: net.Server, sockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let unlinkedOnce = false;

    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code !== "EADDRINUSE") {
        reject(err);
        return;
      }
      const probe = net.connect(sockPath);
      probe.once("connect", () => {
        probe.destroy();
        logLine("another resident is already listening; exiting");
        process.exit(0);
      });
      probe.once("error", (probeErr: NodeJS.ErrnoException) => {
        probe.destroy();
        if (probeErr.code === "ECONNREFUSED" && !unlinkedOnce) {
          unlinkedOnce = true;
          try {
            fs.unlinkSync(sockPath);
          } catch {
            // ignore: someone else may have already cleaned it up
          }
          server.listen(sockPath);
        } else {
          reject(err);
        }
      });
    };

    server.on("error", onError);
    server.once("listening", () => {
      server.removeListener("error", onError);
      resolve();
    });
    server.listen(sockPath);
  });
}
