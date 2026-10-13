declare module "@mtproto/core/src/index.js" {
  import type { EventEmitter } from "events";
  interface Datacenter { id: number; port: number; test?: boolean }
  interface RandomSource { getRandomBytes(length: number): Uint8Array }
  interface CoreTransport extends EventEmitter {
    readonly isAvailable: boolean;
    send(bytes: Uint8Array): Promise<void>;
    close(): void;
  }

  interface StorageInstance {
    get(key: string): string | null | Promise<string | null>;
    set(key: string, value: string): void | Promise<void>;
  }
  interface CoreOptions {
    api_id: number;
    api_hash: string;
    storageOptions: { instance: StorageInstance };
  }
  interface PendingRequest { reject(error: unknown): void }
  interface CoreRpc {
    sendAcks: { (): void; cancel(): void; flush(): void };
    pendingAcks: string[];
    readonly isReady: boolean;
    sendEncryptedMessage(data: Uint8Array, options?: { isContentRelated?: boolean }): Promise<number[]>;
    handleDecryptedMessage(message: { _: string }, params: { messageId: string }): Promise<void>;
    getAESInstance(authKey: Uint8Array, messageKey: Uint8Array, isServer: boolean): Promise<{ decrypt(bytes: Uint8Array): Uint8Array }>;
    transport: CoreTransport;
    messagesWaitAuth: PendingRequest[];
    messagesWaitResponse: Map<string, PendingRequest>;
    handleTransportOpen(): Promise<void>;
    handleMessage(buffer: ArrayBuffer): Promise<void>;
  }
  interface MTProtoClient {
    call<T>(method: string, params?: Record<string, unknown>, options?: { dcId?: number; syncAuth?: boolean }): Promise<T>;
    setDefaultDc(id: number): Promise<void>;
    getRPC(id: number): CoreRpc;
    rpcs: Map<number, CoreRpc>;
    updates: EventEmitter;
  }
  interface CoreEnvironment {
    SHA1(bytes: Uint8Array | ArrayBuffer): Promise<Uint8Array>;
    SHA256(bytes: Uint8Array | ArrayBuffer): Promise<Uint8Array>;
    PBKDF2(password: Uint8Array, salt: Uint8Array, iterations: number): Promise<Uint8Array>;
    getRandomBytes(length: number): Uint8Array;
    getLocalStorage(): StorageInstance;
    createTransport(dc: Datacenter, random: RandomSource): CoreTransport;
  }
  export default function makeMTProto(environment: CoreEnvironment): new (options: CoreOptions) => MTProtoClient;
  export type { CoreRpc, MTProtoClient, StorageInstance };
}
