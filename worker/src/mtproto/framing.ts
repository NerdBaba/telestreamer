const MAX_PAYLOAD = 16 * 1024 * 1024;

export class TransportError extends Error {
  readonly type = "transport";
  constructor(readonly code: number) {
    super(`Telegram transport error ${code}`);
  }
}

export function frameIntermediate(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0 || bytes.length % 4 !== 0 || bytes.length > MAX_PAYLOAD) {
    throw new Error("Invalid intermediate payload length");
  }
  const framed = new Uint8Array(bytes.length + 4);
  new DataView(framed.buffer).setUint32(0, bytes.length, true);
  framed.set(bytes, 4);
  return framed;
}

/** TCP framing is independent of WebSocket message boundaries. */
export class IntermediateFrames {
  private pending = new Uint8Array(0);

  push(bytes: Uint8Array): Uint8Array[] {
    let stream = bytes;
    if (this.pending.length) {
      stream = new Uint8Array(this.pending.length + bytes.length);
      stream.set(this.pending);
      stream.set(bytes, this.pending.length);
      this.pending = new Uint8Array(0);
    }
    const payloads: Uint8Array[] = [];
    let offset = 0;
    while (stream.length - offset >= 4) {
      const view = new DataView(stream.buffer, stream.byteOffset + offset, stream.length - offset);
      const length = view.getUint32(0, true);
      // We never request quick acknowledgements; do not treat one as a payload.
      if (length >= 0x80000000) {
        offset += 4;
        continue;
      }
      if (length === 0 || length % 4 !== 0 || length > MAX_PAYLOAD) {
        throw new Error("Invalid intermediate frame length");
      }
      if (stream.length - offset < length + 4) break;
      const payload = stream.slice(offset + 4, offset + 4 + length);
      if (length === 4) {
        const code = new DataView(payload.buffer).getInt32(0, true);
        if (code >= 0) throw new Error("Invalid Telegram transport error");
        throw new TransportError(-code);
      }
      payloads.push(payload);
      offset += length + 4;
    }
    this.pending = stream.slice(offset);
    return payloads;
  }
}
