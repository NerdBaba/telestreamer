import assert from "node:assert/strict";
import { test } from "node:test";
import AES from "@mtproto/core/src/crypto/aes/index.js";
import { IntermediateFrames, frameIntermediate } from "../src/mtproto/framing";
import { buildReqPq, validateResPq } from "../src/mtproto/protocol";
import { WorkersTransport } from "../src/mtproto/transport";
import { TelegramAuthKeyInvalidError, TelegramClient } from "../src/mtproto/client";
import { TransportError } from "../src/mtproto/framing";
import type { CoreRpc } from "@mtproto/core/src/index.js";

async function withAuthenticatedClient(
  operate: (client: TelegramClient, rpc: CoreRpc, sent: Uint8Array[], failures: Error[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const sent: Uint8Array[] = [];
  const failures: Error[] = [];
  const socket = new EventTarget() as EventTarget & { readyState: number; accept(): void; send(bytes: Uint8Array): void; close(): void };
  socket.readyState = 1;
  socket.accept = () => {};
  socket.send = (bytes) => { sent.push(new Uint8Array(bytes)); };
  socket.close = () => { socket.readyState = 3; };
  globalThis.fetch = async () => ({ status: 101, webSocket: socket }) as unknown as Response;
  const values = new Map<string, string>([
    ["2authKey", JSON.stringify(Array.from({ length: 256 }, (_, i) => i))],
    ["2serverSalt", JSON.stringify(Array(8).fill(1))],
  ]);
  const client = new TelegramClient(1, "test-hash", {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
  }, (error) => { failures.push(error); });
  try {
    const rpc = client.getRPC(2);
    await new Promise<void>((resolve) => rpc.transport.once("open", resolve));
    // Core's open handler reads persisted auth asynchronously.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await client.flushAcknowledgments();
    await operate(client, rpc, sent, failures);
  } finally {
    client.close();
    globalThis.fetch = originalFetch;
  }
}

test("flushAcknowledgments sends the real core ACK queue before close and leaves an empty queue alone", async (t) => {
  await withAuthenticatedClient(async (client, rpc, sent) => {
    await client.flushAcknowledgments();
    assert.equal(sent.length, 2, "empty ACK queue must not send beyond core's startup config request");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await rpc.handleDecryptedMessage({ _: "test_update" }, { messageId: "5" });
    assert.deepEqual(rpc.pendingAcks, ["5"]);
    await client.flushAcknowledgments();
    assert.deepEqual(rpc.pendingAcks, []);
    assert.equal(sent.length, 3, "flush must await the actual socket send");
    const cipher = new AES.CTR(sent[0].slice(8, 40), sent[0].slice(40, 56));
    cipher.encrypt(new Uint8Array(64));
    cipher.encrypt(sent[1]); // Advance past core's startup help.getConfig request.
    const packet = cipher.encrypt(sent[2]).slice(4);
    const aes = await rpc.getAESInstance(Uint8Array.from({ length: 256 }, (_, i) => i), packet.slice(8, 24), false);
    const plaintext = aes.decrypt(packet.slice(24));
    const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    assert.equal(view.getInt32(24, true) % 2, 0, "ACK must not be content-related");
    assert.equal(view.getUint32(32, true), 0x62d6b459, "msgs_ack constructor");
    assert.equal(view.getUint32(36, true), 0x1cb5c415, "TL vector constructor");
    assert.equal(view.getUint32(40, true), 1);
    assert.equal(view.getBigUint64(44, true), 5n);
    await client.flushAcknowledgments();
    assert.equal(sent.length, 3);
    client.close();
    t.mock.timers.tick(550);
    assert.equal(sent.length, 3, "cleanup must cancel the debounced timer");
  });
});

test("only proven transport404 is classified as an invalid auth key", async () => {
  await withAuthenticatedClient(async (_client, rpc, _sent, failures) => {
    const payload = new Uint8Array(4);
    new DataView(payload.buffer).setInt32(0, -404, true);
    assert.throws(() => new IntermediateFrames().push(frameIntermediate(payload)), (error) => {
      rpc.transport.emit("error", error);
      return error instanceof TransportError;
    });
    assert.ok(failures.at(-1) instanceof TelegramAuthKeyInvalidError);
    rpc.transport.emit("error", { type: "socket", code: 404, message: "secret-token" });
    assert.equal(failures.at(-1)?.message, "Telegram connection failed");
    assert.ok(!(failures.at(-1) instanceof TelegramAuthKeyInvalidError));
    rpc.transport.emit("error", new TransportError(429));
    assert.ok(!(failures.at(-1) instanceof TelegramAuthKeyInvalidError));
  });
});

test("ACK encryption failures reject flush without exposing secret payloads", async () => {
  await withAuthenticatedClient(async (client, rpc, sent, failures) => {
    rpc.getAESInstance = async () => { throw new Error("secret-auth-key"); };
    await rpc.handleDecryptedMessage({ _: "test_update" }, { messageId: "5" });
    await assert.rejects(client.flushAcknowledgments(), { message: "Telegram connection failed" });
    assert.equal(sent.length, 2);
    assert.equal(failures.at(-1)?.message, "Telegram connection failed");
  });
});

function resPq(nonce: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(84);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(8, 5n, true);
  view.setUint32(16, 64, true);
  view.setUint32(20, 0x05162463, true);
  bytes.set(nonce, 24);
  bytes.fill(1, 40, 56);
  bytes[56] = 8;
  bytes.set([0x17, 0xed, 0x48, 0x94, 0x1a, 0x08, 0xf9, 0x81], 57);
  view.setUint32(68, 0x1cb5c415, true);
  view.setUint32(72, 1, true);
  view.setBigUint64(76, 0x123456789abcdef0n, true);
  return bytes;
}

test("req_pq_multi carries an unencrypted envelope and the caller nonce", () => {
  const nonce = new Uint8Array(16).fill(7);
  const request = buildReqPq(nonce, 1_700_000_000_123);
  const view = new DataView(request.buffer);
  assert.equal(view.getBigUint64(0, true), 0n);
  assert.equal(view.getBigUint64(8, true) % 4n, 0n);
  assert.equal(view.getUint32(16, true), 20);
  assert.equal(view.getUint32(20, true), 0xbe7e8ef1);
  assert.deepEqual(request.subarray(24), nonce);
});

test("probe validates TL resPQ rather than accepting an arbitrary 64-byte reply", () => {
  const nonce = new Uint8Array(16).fill(7);
  assert.throws(() => validateResPq(new Uint8Array(64), nonce), /message length/);
  assert.equal(validateResPq(resPq(nonce), nonce).fingerprints[0], "123456789abcdef0");
});

test("probe rejects a resPQ for a different nonce", () => {
  assert.throws(() => validateResPq(resPq(new Uint8Array(16)), new Uint8Array(16).fill(1)), /nonce/);
});

test("probe rejects wrong constructor, nonzero auth key and malformed TL vector", () => {
  const nonce = new Uint8Array(16);
  for (const [offset, value, pattern] of [[20, 0x12345678, /resPQ/], [0, 1, /auth_key_id/], [72, 99, /fingerprint/]] as const) {
    const bytes = resPq(nonce);
    new DataView(bytes.buffer).setUint32(offset, value, true);
    assert.throws(() => validateResPq(bytes, nonce), pattern);
  }
});

test("intermediate parser reassembles fragmented frames and separates coalesced replies", () => {
  const parser = new IntermediateFrames();
  const first = frameIntermediate(new Uint8Array(20).fill(1));
  const second = frameIntermediate(new Uint8Array(24).fill(2));
  assert.deepEqual(parser.push(first.subarray(0, 2)), []);
  const rest = new Uint8Array(first.length - 2 + second.length);
  rest.set(first.subarray(2));
  rest.set(second, first.length - 2);
  assert.deepEqual(parser.push(rest), [new Uint8Array(20).fill(1), new Uint8Array(24).fill(2)]);
});

test("intermediate parser rejects invalid length and Telegram transport errors", () => {
  const invalid = new Uint8Array(4);
  new DataView(invalid.buffer).setUint32(0, 0x7fffffff, true);
  assert.throws(() => new IntermediateFrames().push(invalid), /length/);
  const error = new Uint8Array(4);
  new DataView(error.buffer).setInt32(0, -404, true);
  assert.throws(() => new IntermediateFrames().push(frameIntermediate(error)), /404/);
});

test("Workers transport sends initialization without an open event and decrypts a real framed reply", async () => {
  const sent: Uint8Array[] = [];
  const socket = new EventTarget() as EventTarget & { readyState: number; send(bytes: Uint8Array): void; close(): void };
  socket.readyState = 1;
  socket.send = (bytes) => { sent.push(new Uint8Array(bytes)); };
  socket.close = () => { socket.readyState = 3; };
  const transport = new WorkersTransport({ id: 2, port: 443 }, {
    getRandomBytes: (length) => Uint8Array.from({ length }, (_, i) => i + 1),
  }, async () => socket as unknown as WebSocket);
  await new Promise<void>((resolve, reject) => { transport.once("open", resolve); transport.once("error", reject); });
  assert.equal(sent[0].length, 64);
  await transport.send(new Uint8Array(20));
  assert.equal(sent[1].length, 24);
  // The dependency cipher and framing are exercised through the public transport.
  const init = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
  new DataView(init.buffer).setUint32(56, 0xeeeeeeee, true);
  const reverse = init.slice().reverse();
  const cipher = new AES.CTR(reverse.slice(8, 40), reverse.slice(40, 56));
  const payload = new Uint8Array(20).fill(9);
  const encrypted = cipher.encrypt(frameIntermediate(payload));
  const received = new Promise<ArrayBuffer>((resolve, reject) => { transport.once("message", resolve); transport.once("error", reject); });
  socket.dispatchEvent(new MessageEvent("message", { data: encrypted.slice(0, 7).buffer }));
  socket.dispatchEvent(new MessageEvent("message", { data: encrypted.slice(7).buffer }));
  assert.deepEqual(new Uint8Array(await received), payload);
  transport.close();
});

test("upgrade failure is observable and leaves the transport unavailable", async () => {
  const transport = new WorkersTransport({ id: 2, port: 443 }, {
    getRandomBytes: (length) => new Uint8Array(length),
  }, async () => { throw new Error("Refused"); });
  const failure = await new Promise<{ type: string }>((resolve) => transport.once("error", resolve));
  assert.equal(failure.type, "socket");
  assert.equal(transport.isAvailable, false);
});

test("closing during upgrade closes a late socket instead of leaking it", async () => {
  let deliver: (socket: WebSocket) => void = () => {};
  const socket = { close: () => { closes++; } };
  let closes = 0;
  const transport = new WorkersTransport({ id: 2, port: 443 }, {
    getRandomBytes: (length) => new Uint8Array(length),
  }, () => new Promise<WebSocket>((resolve) => { deliver = resolve; }));
  transport.close();
  deliver(socket as unknown as WebSocket);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.equal(transport.isAvailable, false);
});
