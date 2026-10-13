export function buildReqPq(nonce: Uint8Array, now = Date.now()): Uint8Array {
  if (nonce.length !== 16) throw new Error("nonce must contain 16 bytes");
  const packet = new Uint8Array(40);
  const view = new DataView(packet.buffer);
  // msg_id is seconds * 2^32 plus the fractional second, divisible by four.
  const messageId = (BigInt(Math.floor(now / 1000)) << 32n)
    | ((BigInt(now % 1000) * (1n << 32n) / 1000n) & ~3n);
  view.setBigUint64(8, messageId, true);
  view.setUint32(16, 20, true);
  view.setUint32(20, 0xbe7e8ef1, true);
  packet.set(nonce, 24);
  return packet;
}

export interface ResPq {
  pq: string;
  fingerprints: string[];
  messageId: string;
}

/** Validate the complete unencrypted MTProto envelope and TL resPQ body. */
export function validateResPq(packet: Uint8Array, nonce: Uint8Array): ResPq {
  if (packet.length < 20) throw new Error("Truncated MTProto message length");
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (view.getBigUint64(0, true) !== 0n) throw new Error("Expected zero auth_key_id");
  const length = view.getUint32(16, true);
  if (length !== packet.length - 20 || length < 56 || length % 4 !== 0) {
    throw new Error("Invalid MTProto message length");
  }
  if (view.getBigUint64(8, true) % 2n !== 1n) throw new Error("Invalid server message id");
  if (view.getUint32(20, true) !== 0x05162463) throw new Error("Expected TL resPQ constructor");
  if (nonce.length !== 16 || !nonce.every((byte, index) => packet[24 + index] === byte)) {
    throw new Error("resPQ nonce mismatch");
  }
  let offset = 56;
  let pqLength = packet[offset++];
  let headerLength = 1;
  if (pqLength === 254) {
    if (offset + 3 > packet.length) throw new Error("Truncated TL pq length");
    pqLength = packet[offset] | (packet[offset + 1] << 8) | (packet[offset + 2] << 16);
    offset += 3;
    headerLength = 4;
  }
  if (pqLength < 1 || pqLength > 8 || offset + pqLength > packet.length) {
    throw new Error("Invalid resPQ pq length");
  }
  const pq = Array.from(packet.subarray(offset, offset + pqLength), (byte) => byte.toString(16).padStart(2, "0")).join("");
  offset += pqLength;
  const padding = (4 - ((headerLength + pqLength) % 4)) % 4;
  if (offset + padding + 8 > packet.length) throw new Error("Truncated resPQ fingerprint vector");
  for (let i = 0; i < padding; i++) {
    if (packet[offset + i] !== 0) throw new Error("Invalid TL pq padding");
  }
  offset += padding;
  if (view.getUint32(offset, true) !== 0x1cb5c415) throw new Error("Invalid resPQ fingerprint vector");
  const count = view.getUint32(offset + 4, true);
  offset += 8;
  if (count === 0 || count > 64 || offset + count * 8 !== packet.length) {
    throw new Error("Invalid resPQ fingerprint count");
  }
  const fingerprints: string[] = [];
  for (let i = 0; i < count; i++) {
    fingerprints.push(view.getBigUint64(offset + i * 8, true).toString(16).padStart(16, "0"));
  }
  return { pq, fingerprints, messageId: view.getBigUint64(8, true).toString() };
}
