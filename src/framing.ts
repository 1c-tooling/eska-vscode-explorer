import { TextDecoder } from "node:util";
import { ExplorerError, MAX_HEADER, MAX_REQUEST, MAX_RESPONSE } from "./protocol.js";

/** Incremental framing allocates each body once, even for one-byte pipe chunks. */
export class FrameReader {
  private header: number[] = [];
  private body: Buffer | undefined;
  private offset = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  /** Deliver complete JSON values in wire order and retain only the incomplete frame. */
  push(chunk: Buffer, accept: (value: unknown) => void): void {
    let position = 0;
    while (position < chunk.length) {
      if (!this.body) {
        const byte = chunk[position++];
        if (byte === undefined || byte > 127 || this.header.length === MAX_HEADER) {
          throw new ExplorerError("protocolInvalid");
        }
        this.header.push(byte);
        const end = this.header.length;
        if (end < 4 || this.header[end - 4] !== 13 || this.header[end - 3] !== 10
          || this.header[end - 2] !== 13 || this.header[end - 1] !== 10) continue;
        const lines = Buffer.from(this.header).toString("ascii").slice(0, -4).split("\r\n");
        let size: number | undefined;
        for (const line of lines) {
          const separator = line.indexOf(":");
          if (separator < 1) throw new ExplorerError("protocolInvalid");
          if (line.slice(0, separator).toLowerCase() !== "content-length") continue;
          const text = line.slice(separator + 1).trim();
          if (size !== undefined || !/^[0-9]+$/.test(text)) throw new ExplorerError("protocolInvalid");
          size = Number(text);
        }
        if (size === undefined || !Number.isSafeInteger(size) || size < 1 || size > MAX_RESPONSE) {
          throw new ExplorerError("protocolInvalid");
        }
        this.body = Buffer.allocUnsafe(size);
        this.offset = 0;
        this.header = [];
      } else {
        const count = Math.min(chunk.length - position, this.body.length - this.offset);
        chunk.copy(this.body, this.offset, position, position + count);
        position += count;
        this.offset += count;
        if (this.offset !== this.body.length) continue;
        const complete = this.body;
        this.body = undefined;
        this.offset = 0;
        let value: unknown;
        try { value = JSON.parse(this.decoder.decode(complete)) as unknown; }
        catch { throw new ExplorerError("protocolInvalid"); }
        accept(value);
      }
    }
  }

  /** A truncated frame is a protocol error, including during orderly shutdown. */
  finish(): void {
    if (this.body || this.header.length) throw new ExplorerError("protocolInvalid");
  }
}

/** Count UTF-8 bytes rather than UTF-16 characters when writing Cyrillic paths. */
export function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_REQUEST) throw new ExplorerError("resourceLimit");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}
