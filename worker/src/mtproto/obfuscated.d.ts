declare module "@mtproto/core/src/transport/obfuscated/index.js" {
  import { EventEmitter } from "events";
  export default class Obfuscated extends EventEmitter {
    crypto: { getRandomBytes(length: number): Uint8Array };
    generateObfuscationKeys(): Promise<Uint8Array>;
    obfuscate(bytes: Uint8Array): Promise<Uint8Array>;
    deobfuscate(bytes: Uint8Array): Promise<Uint8Array>;
  }
}

declare module "@mtproto/core/src/crypto/aes/index.js" {
  class CTR {
    constructor(key: Uint8Array, iv: Uint8Array);
    encrypt(bytes: Uint8Array): Uint8Array;
    decrypt(bytes: Uint8Array): Uint8Array;
  }
  const AES: { CTR: typeof CTR };
  export default AES;
}
