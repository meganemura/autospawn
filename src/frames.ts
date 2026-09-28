// Responsibility: the framed form of the direction from serve to connect
// (ADR 0009). A frame is one type byte, a 4-byte big-endian length, and
// that many bytes of payload. Data frames carry the child's stdout; one
// exit frame, last, carries how the child ended. This module builds frames,
// takes them back out of a byte stream split at any point, and turns an
// exit status into connect's exit code.
//
// Not done here: deciding whether a connection uses frames (the attach
// header and its reply do that), or the direction from connect to serve,
// which stays a raw stream: the child's stdin.
import os from "node:os";

export const FRAME_DATA = 1;
export const FRAME_EXIT = 2;

const HEADER_BYTES = 5;
// A data frame holds one chunk of a pipe read, which stays far below this.
// The limit keeps a corrupt length from making connect buffer without end.
export const MAX_FRAME_PAYLOAD = 16 * 1024 * 1024;

export type ExitStatus = { code: number | null; signal: string | null };
export type Frame = { type: number; payload: Buffer };

export function encodeFrame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function encodeExit(status: ExitStatus): Buffer {
  return encodeFrame(FRAME_EXIT, Buffer.from(JSON.stringify(status)));
}

export class FrameError extends Error {}

// Collects bytes as they arrive and returns every frame completed so far.
// A frame may arrive split across any number of chunks.
export class FrameDecoder {
  #buf = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    const frames: Frame[] = [];
    while (this.#buf.length >= HEADER_BYTES) {
      const type = this.#buf.readUInt8(0);
      const length = this.#buf.readUInt32BE(1);
      if (length > MAX_FRAME_PAYLOAD) {
        throw new FrameError(`frame of ${length} bytes is over the limit`);
      }
      if (this.#buf.length < HEADER_BYTES + length) break;
      frames.push({ type, payload: this.#buf.subarray(HEADER_BYTES, HEADER_BYTES + length) });
      this.#buf = this.#buf.subarray(HEADER_BYTES + length);
    }
    return frames;
  }

  // Bytes that arrived but do not complete a frame yet.
  get pending(): number {
    return this.#buf.length;
  }
}

export function parseExit(payload: Buffer): ExitStatus {
  const value: unknown = JSON.parse(payload.toString("utf8"));
  const invalid = new FrameError("exit frame is not {code, signal}");
  // Check the shape before reading a field: JSON.parse can give null.
  if (typeof value !== "object" || value === null) throw invalid;
  const { code, signal } = value as { code?: unknown; signal?: unknown };
  if (!(code === null || Number.isInteger(code))) throw invalid;
  if (!(signal === null || typeof signal === "string")) throw invalid;
  return { code: code as number | null, signal: signal as string | null };
}

// The exit code connect uses for a child's status, as a shell would: the
// child's own code, or 128 plus the signal's number for a child a signal
// ended. A status with neither, or a code outside 0-255, gives 1.
export function exitCodeFor(status: ExitStatus): number {
  if (status.signal !== null) {
    const number = (os.constants.signals as Record<string, number | undefined>)[status.signal];
    return number === undefined ? 1 : 128 + number;
  }
  if (status.code !== null && status.code >= 0 && status.code <= 255) return status.code;
  return 1;
}
