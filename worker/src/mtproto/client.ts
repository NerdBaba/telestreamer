import makeMTProto from "@mtproto/core/src/index.js";
import type { StorageInstance } from "@mtproto/core/src/index.js";
import { createWorkersTransport } from "./transport";
import { TransportError } from "./framing";

const MTProto = makeMTProto({
  SHA1: async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)),
  SHA256: async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  PBKDF2: async (password, salt, iterations) => {
    const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({
      name: "PBKDF2", hash: "SHA-512", salt, iterations,
    }, key, 512));
  },
  getRandomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  getLocalStorage: () => { throw new Error("A request-owned storage instance is required"); },
  createTransport: createWorkersTransport,
});

export interface TelegramRpcError { error_code: number; error_message: string }

/** Telegram explicitly reports that the persisted authorization key is missing. */
export class TelegramAuthKeyInvalidError extends Error {
  constructor() {
    super("Telegram authorization key is invalid");
    this.name = "TelegramAuthKeyInvalidError";
  }
}

export function isTelegramRpcError(error: unknown): error is TelegramRpcError {
  return !!error && typeof error === "object" && "error_code" in error
    && typeof error.error_code === "number" && "error_message" in error
    && typeof error.error_message === "string";
}

/** The stock core message listener discards async rejections. Own it here. */
export class TelegramClient extends MTProto {
  private disposed = false;
  private readonly onFailure: (error: Error) => void;
  private failure: Error | null = null;
  private readonly pendingSends = new Set<Promise<unknown>>();

  constructor(apiId: number, apiHash: string, storage: StorageInstance, onFailure: (error: Error) => void) {
    super({ api_id: apiId, api_hash: apiHash, storageOptions: { instance: storage } });
    this.onFailure = onFailure;
  }

  override getRPC(id: number) {
    if (this.disposed) throw new Error("Telegram client is closed");
    const existing = this.rpcs.has(id);
    const rpc = super.getRPC(id);
    if (existing) return rpc;
    const fail = (error: unknown) => {
      const failure = error instanceof TransportError && error.code === 404
        ? new TelegramAuthKeyInvalidError() : new Error("Telegram connection failed");
      this.failure = failure;
      this.onFailure(failure);
    };
    // Own errors too: core logs raw payloads and starts unawaited storage writes.
    rpc.transport.removeAllListeners("error");
    const track = <T>(operation: Promise<T>): Promise<T> => {
      this.pendingSends.add(operation);
      void operation.catch(fail).finally(() => { this.pendingSends.delete(operation); });
      return operation;
    };
    const send = rpc.transport.send.bind(rpc.transport);
    rpc.transport.send = (bytes) => track(send(bytes));
    const sendEncryptedMessage = rpc.sendEncryptedMessage.bind(rpc);
    rpc.sendEncryptedMessage = (bytes, options) => {
      const operation = track(sendEncryptedMessage(bytes, options));
      // Core's debounced ACK callback discards this promise.
      void operation.catch(() => {});
      return operation;
    };
    rpc.transport.removeAllListeners("open");
    rpc.transport.removeAllListeners("message");
    rpc.transport.on("open", () => { void rpc.handleTransportOpen().catch(fail); });
    let incoming = Promise.resolve();
    rpc.transport.on("message", (buffer: ArrayBuffer) => {
      incoming = incoming.then(() => rpc.handleMessage(buffer)).catch(fail);
    });
    rpc.transport.on("error", fail);
    return rpc;
  }

  /** Telegram PHONE_MIGRATE is part of login, not a generic retry policy. */
  async invoke<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.call<T>(method, params, { syncAuth: false });
    } catch (error) {
      if (!isTelegramRpcError(error)) throw error;
      const match = /^(?:PHONE|USER|NETWORK)_MIGRATE_([1-5])$/.exec(error.error_message);
      if (!match || error.error_code !== 303) throw error;
      await this.setDefaultDc(Number(match[1]));
      return this.call<T>(method, params, { syncAuth: false });
    }
  }

  /** Core's debounce discards its async send; wait for encryption and socket writes. */
  async flushAcknowledgments(): Promise<void> {
    if (this.disposed) throw new Error("Telegram client is closed");
    if (this.failure) throw this.failure;
    for (const rpc of this.rpcs.values()) {
      if (!rpc.pendingAcks.length) continue;
      if (!rpc.isReady) throw new Error("Telegram connection failed");
      rpc.sendAcks.flush();
    }
    while (this.pendingSends.size) {
      try {
        await Promise.all(this.pendingSends);
      } catch {
        throw this.failure ?? new Error("Telegram connection failed");
      }
    }
    if (this.failure) throw this.failure;
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const rpc of this.rpcs.values()) {
      rpc.sendAcks.cancel();
      for (const request of rpc.messagesWaitAuth) request.reject(new Error("Telegram request ended"));
      for (const request of rpc.messagesWaitResponse.values()) request.reject(new Error("Telegram request ended"));
      rpc.messagesWaitAuth.length = 0;
      rpc.messagesWaitResponse.clear();
      rpc.transport.close();
      rpc.transport.removeAllListeners();
    }
    this.rpcs.clear();
    this.updates.removeAllListeners();
  }
}
