import Obfuscated from "@mtproto/core/src/transport/obfuscated/index.js";
import { IntermediateFrames, TransportError, frameIntermediate } from "./framing";
import { bind, dcWebsocketUrl, openMtpSocket } from "./workers-transport";

export interface Datacenter { id: number; port: number; test?: boolean }
export interface RandomSource { getRandomBytes(length: number): Uint8Array }
type SocketOpener = (url: string, signal?: AbortSignal) => Promise<WebSocket>;

/** One request-owned connection; no isolate-level sockets or implicit reconnect. */
export class WorkersTransport extends Obfuscated {
  private socket: WebSocket | null = null;
  private stopped = false;
  private initialized = false;
  private readonly controller = new AbortController();
  private readonly frames = new IntermediateFrames();
  private incoming = Promise.resolve();
  private outgoing = Promise.resolve();

  constructor(
    dc: Datacenter,
    random: RandomSource,
    openSocket: SocketOpener = openMtpSocket,
  ) {
    super();
    this.crypto = random;
    // EventEmitter otherwise throws before the RPC consumer can report failure.
    this.on("error", () => {});
    void this.connect(dc, openSocket);
  }

  get isAvailable(): boolean {
    return !this.stopped && this.initialized && this.socket?.readyState === 1;
  }

  private async connect(dc: Datacenter, openSocket: SocketOpener): Promise<void> {
    const deadline = setTimeout(() => { this.fail({ type: "socket", message: "WebSocket upgrade timed out" }); }, 10_000);
    try {
      const socket = await openSocket(dcWebsocketUrl(dc), this.controller.signal);
      if (this.stopped) { socket.close(); return; }
      this.socket = socket;
      const init = await this.generateObfuscationKeys();
      if (this.stopped) { socket.close(); return; }
      bind(socket, {
        emit: (event, ...args) => {
          if (event === "message") {
            this.incoming = this.incoming.then(async () => {
              if (this.stopped) return;
              const buffer = args[0];
              if (!(buffer instanceof ArrayBuffer)) throw new Error("Invalid binary frame");
              const decoded = await this.deobfuscate(new Uint8Array(buffer));
              for (const payload of this.frames.push(decoded)) {
                this.emit("message", payload.buffer);
              }
            }).catch((error: unknown) => {
              this.fail(error instanceof TransportError ? error : { type: "socket", message: "Invalid MTProto frame" });
            });
          } else if (event === "error") {
            this.fail(args[0]);
          } else if (event === "close") {
            this.fail({ type: "socket", message: "Telegram closed the connection" });
          }
          return true;
        },
      });
      socket.send(init);
      this.initialized = true;
      this.emit("open");
    } catch {
      if (!this.stopped) this.fail({ type: "socket", message: "Telegram connection failed" });
    } finally {
      clearTimeout(deadline);
    }
  }

  /** Cipher state and socket sends must advance in the same order. */
  send(bytes: Uint8Array): Promise<void> {
    this.outgoing = this.outgoing.then(async () => {
      if (!this.isAvailable || !this.socket) throw new Error("Transport is unavailable");
      const framed = frameIntermediate(bytes);
      this.socket.send(await this.obfuscate(framed));
    }).catch(() => { this.fail({ type: "socket", message: "Telegram send failed" }); });
    return this.outgoing;
  }

  private fail(error: unknown): void {
    if (this.stopped) return;
    this.emit("error", error);
    this.close();
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.initialized = false;
    this.controller.abort();
    if (this.socket && this.socket.readyState < 2) this.socket.close(1000, "Request complete");
    this.socket = null;
    this.emit("close");
  }
}

export function createWorkersTransport(dc: Datacenter, random: RandomSource): WorkersTransport {
  return new WorkersTransport(dc, random);
}
