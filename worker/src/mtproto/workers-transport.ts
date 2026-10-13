const DC_WS_HOSTS: Record<number, string> = {
  1: "pluto", 2: "venus", 3: "aurora", 4: "vesta", 5: "flora",
};

export function dcWebsocketUrl(dc: { id: number; test?: boolean }): string {
  const host = DC_WS_HOSTS[dc.id];
  if (!host) throw new Error(`No WebSocket host for DC ${dc.id}`);
  return `https://${host}.web.telegram.org${dc.test ? "/apiws_test" : "/apiws"}`;
}

/** An accepted Workers socket is already open; it emits no browser open event. */
export async function openMtpSocket(url: string, signal?: AbortSignal): Promise<WebSocket> {
  const response = await fetch(url, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "binary" },
    signal,
  });
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) {
    await response.body?.cancel();
    throw new Error(`Telegram WebSocket upgrade refused (${response.status})`);
  }
  socket.binaryType = "arraybuffer";
  socket.accept();
  return socket;
}

export interface FrameSink {
  emit(event: string, ...args: unknown[]): boolean;
}

/** Keep binary conversion ordered, including Blob frames on older runtimes. */
export function bind(socket: WebSocket, sink: FrameSink): void {
  let incoming = Promise.resolve();
  socket.addEventListener("message", (event: MessageEvent) => {
    incoming = incoming.then(async () => {
      const data: unknown = event.data;
      let buffer: ArrayBuffer;
      if (data instanceof ArrayBuffer) {
        buffer = data;
      } else if (ArrayBuffer.isView(data)) {
        const copy = new Uint8Array(data.byteLength);
        copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        buffer = copy.buffer;
      } else if (data instanceof Blob) {
        buffer = await data.arrayBuffer();
      } else {
        throw new Error("Telegram sent a nonbinary WebSocket frame");
      }
      sink.emit("message", buffer);
    }).catch(() => { sink.emit("error", { type: "socket" }); });
  });
  socket.addEventListener("close", (event: CloseEvent) => { sink.emit("close", event.code); });
  socket.addEventListener("error", () => { sink.emit("error", { type: "socket" }); });
}
