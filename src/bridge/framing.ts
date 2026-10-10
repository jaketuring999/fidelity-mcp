import { endianness } from 'node:os';

const MAX_MESSAGE_BYTES = 256 * 1024;

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length === 0 || body.length > MAX_MESSAGE_BYTES) throw new Error('Invalid message size');
  const header = Buffer.alloc(4);
  if (endianness() === 'LE') header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export class MessageDecoder {
  private buffered: Buffer = Buffer.alloc(0);
  constructor(private readonly onMessage: (message: unknown) => void) {}
  push(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (this.buffered.length >= 4) {
      const size =
        endianness() === 'LE' ? this.buffered.readUInt32LE() : this.buffered.readUInt32BE();
      if (size === 0 || size > MAX_MESSAGE_BYTES) throw new Error('Invalid message size');
      if (this.buffered.length < size + 4) return;
      const body = this.buffered.subarray(4, size + 4);
      this.buffered = this.buffered.subarray(size + 4);
      this.onMessage(JSON.parse(body.toString('utf8')) as unknown);
    }
  }
}
