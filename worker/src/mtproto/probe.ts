import { WorkersTransport } from "./transport";
import { buildReqPq, validateResPq } from "./protocol";
import type { ResPq } from "./protocol";
import { dcWebsocketUrl } from "./workers-transport";

/** Anonymous reachability proof: req_pq_multi -> nonce-validated TL resPQ. */
export async function handleProbe(url: URL): Promise<Response> {
  const dcId = Number(url.searchParams.get("dc") ?? "1");
  if (!Number.isInteger(dcId) || dcId < 1 || dcId > 5) {
    return Response.json({ error: "dc must be an integer 1..5" }, { status: 400 });
  }
  const dc = { id: dcId, port: 443 };
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const transport = new WorkersTransport(dc, {
    getRandomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  });
  const started = Date.now();
  let timer: number | null = null;
  try {
    const reply = await new Promise<ResPq>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("req_pq_multi round-trip timed out")), 12_000);
      transport.once("open", () => { void transport.send(buildReqPq(nonce)); });
      transport.once("error", (error: unknown) => {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        reject(new Error(code ? `Telegram transport error ${code}` : "Telegram WebSocket failed"));
      });
      transport.once("message", (buffer: ArrayBuffer) => {
        try { resolve(validateResPq(new Uint8Array(buffer), nonce)); }
        catch (error) { reject(error); }
      });
    });
    return Response.json({
      ok: true,
      dc: dcId,
      url: dcWebsocketUrl(dc),
      protocol: "obfuscated-intermediate",
      request: "req_pq_multi",
      response: "resPQ",
      nonce_validated: true,
      pq: reply.pq,
      server_public_key_fingerprints: reply.fingerprints,
      elapsed_ms: Date.now() - started,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({
      ok: false,
      dc: dcId,
      request: "req_pq_multi",
      error: error instanceof Error ? error.message : "MTProto probe failed",
      elapsed_ms: Date.now() - started,
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  } finally {
    clearTimeout(timer);
    transport.close();
    transport.removeAllListeners();
  }
}
