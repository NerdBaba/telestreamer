import { TelegramAuthKeyInvalidError, TelegramClient, isTelegramRpcError } from "./client";
import { createSrpProof } from "./srp";

export interface TelegramEnv {
  ADMIN_TOKEN?: string;
  DB?: D1Database;
  TELEGRAM_API_ID?: string;
  TELEGRAM_API_HASH?: string;
  SESSION_ENCRYPTION_KEY?: string;
}

interface PublicUser { id: string; first_name: string; last_name?: string; username?: string }
interface TelegramUser { _: string; id: string | number; first_name?: string; last_name?: string; username?: string }
interface Authorization { _: string; user?: TelegramUser }
interface SentCode { _: string; phone_code_hash?: string; type?: { _: string }; timeout?: number; authorization?: Authorization }
interface PasswordInfo {
  srp_id: string;
  srp_B: Uint8Array;
  current_algo: { _: string; g: number; p: Uint8Array; salt1: Uint8Array; salt2: Uint8Array };
}
interface LoginState {
  storage: Record<string, string>;
  status: "signed_out" | "code_sent" | "password_required" | "authorized";
  user?: PublicUser;
  pending?: { phone: string; hash: string; expires: number };
}

class RouteError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

function json(body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RouteError(415, "invalid_request", "Use application/json");
  }
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) {
        await reader.cancel();
        throw new RouteError(413, "invalid_request", "Request body is too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes) || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected object");
    return body as Record<string, unknown>;
  } catch { throw new RouteError(400, "invalid_request", "Expected a JSON object"); }
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  try {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(secret)) throw new Error("Invalid encoding");
    const bytes = Uint8Array.from(atob(secret), (char) => char.charCodeAt(0));
    if (bytes.length !== 32) throw new Error("Invalid length");
    return await crypto.subtle.importKey("raw", bytes.buffer, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch { throw new RouteError(503, "setup_required", "SESSION_ENCRYPTION_KEY must be 32 random bytes encoded as base64"); }
}

async function decodeState(ciphertext: string | null, key: CryptoKey): Promise<LoginState> {
  if (!ciphertext) return { storage: {}, status: "signed_out" };
  try {
    const [iv64, data64, extra] = ciphertext.split(".");
    if (extra || !iv64 || !data64) throw new Error("Invalid session encoding");
    const iv = Uint8Array.from(atob(iv64), (char) => char.charCodeAt(0));
    const data = Uint8Array.from(atob(data64), (char) => char.charCodeAt(0));
    if (iv.length !== 12) throw new Error("Invalid IV");
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM", iv: iv.buffer,
      additionalData: new TextEncoder().encode("tintustream:telegram:primary:v1"),
    }, key, data.buffer);
    const state = JSON.parse(new TextDecoder().decode(plaintext)) as LoginState;
    if (!state.storage || !["signed_out", "code_sent", "password_required", "authorized"].includes(state.status)) {
      throw new Error("Invalid session state");
    }
    return state;
  } catch { throw new RouteError(503, "storage_unavailable", "Unable to decrypt Telegram session; restore its encryption key"); }
}

async function encodeState(state: LoginState, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM", iv: iv.buffer,
    additionalData: new TextEncoder().encode("tintustream:telegram:primary:v1"),
  }, key, new TextEncoder().encode(JSON.stringify(state))));
  // Session state is bounded to a few kilobytes; do not expose these values.
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...data))}`;
}

function authorize(state: LoginState, result: Authorization): void {
  if (result._ === "auth.authorizationSignUpRequired") {
    throw new RouteError(409, "signup_required", "Use an existing Telegram account");
  }
  if (result._ !== "auth.authorization" || !result.user || result.user._ !== "user") {
    throw new RouteError(502, "telegram_error", "Unexpected Telegram authorization response");
  }
  const user = result.user;
  state.status = "authorized";
  state.user = { id: String(user.id), first_name: user.first_name ?? "", last_name: user.last_name, username: user.username };
  delete state.pending;
}

async function operate(action: string, body: Record<string, unknown>, state: LoginState, client: TelegramClient): Promise<Record<string, unknown>> {
  if (action === "send-code") {
    if (state.status === "authorized") throw new RouteError(409, "already_authorized", "Log out before changing accounts");
    if (typeof body.phone !== "string" || !/^\+[1-9]\d{5,14}$/.test(body.phone)) {
      throw new RouteError(400, "invalid_request", "phone must use international +countrycode format");
    }
    const result = await client.invoke<SentCode>("auth.sendCode", {
      phone_number: body.phone, settings: { _: "codeSettings" },
    });
    if (result._ === "auth.sentCodeSuccess" && result.authorization) {
      authorize(state, result.authorization);
      return { ok: true, status: state.status, authorized: true, user: state.user };
    }
    if (result._ !== "auth.sentCode" || !result.phone_code_hash || !result.type) {
      throw new RouteError(502, "telegram_error", "Unexpected Telegram send-code response");
    }
    state.pending = { phone: body.phone, hash: result.phone_code_hash, expires: Date.now() + 10 * 60_000 };
    state.status = "code_sent";
    delete state.user;
    return { ok: true, status: state.status, delivery: result.type._, timeout: result.timeout };
  }
  if (action === "sign-in") {
    if (state.status === "authorized") return { ok: true, status: state.status, authorized: true, user: state.user };
    if (!state.pending || state.pending.expires < Date.now()) {
      throw new RouteError(409, "code_required", "Send a new login code first");
    }
    if (state.status === "password_required") {
      if (typeof body.password !== "string" || !body.password || body.password.length > 1024) {
        throw new RouteError(400, "invalid_request", "Enter your Telegram two-step verification password");
      }
      const info = await client.invoke<PasswordInfo>("account.getPassword");
      if (info.current_algo._ !== "passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow") {
        throw new RouteError(502, "telegram_error", "Unsupported Telegram password algorithm");
      }
      const proof = await createSrpProof({ ...info.current_algo, gB: info.srp_B }, body.password);
      authorize(state, await client.invoke<Authorization>("auth.checkPassword", {
        password: { _: "inputCheckPasswordSRP", srp_id: info.srp_id, ...proof },
      }));
    } else {
      if (typeof body.code !== "string" || !/^\d{3,8}$/.test(body.code)) {
        throw new RouteError(400, "invalid_request", "Enter the Telegram login code");
      }
      try {
        authorize(state, await client.invoke<Authorization>("auth.signIn", {
          phone_number: state.pending.phone, phone_code_hash: state.pending.hash, phone_code: body.code,
        }));
      } catch (error) {
        if (!isTelegramRpcError(error) || error.error_message !== "SESSION_PASSWORD_NEEDED") throw error;
        state.status = "password_required";
        return { ok: true, status: state.status, authorized: false };
      }
    }
    return { ok: true, status: state.status, authorized: true, user: state.user };
  }
  if (action === "logout") {
    // Never claim a remote logout when Telegram is unreachable.
    if (state.status === "authorized") await client.invoke("auth.logOut");
    state.storage = {};
    state.status = "signed_out";
    delete state.pending;
    delete state.user;
    return { ok: true, status: state.status, authorized: false };
  }
  if (state.status === "authorized") {
    try {
      const users = await client.invoke<TelegramUser[]>("users.getUsers", { id: [{ _: "inputUserSelf" }] });
      if (users.length !== 1 || users[0]._ !== "user") throw new Error("Invalid current user");
      const user = users[0];
      state.user = { id: String(user.id), first_name: user.first_name ?? "", last_name: user.last_name, username: user.username };
    } catch (error) {
      if (!isTelegramRpcError(error) || error.error_code !== 401) throw error;
      state.storage = {};
      state.status = "signed_out";
      delete state.pending;
      delete state.user;
    }
  } else if (state.pending && state.pending.expires < Date.now()) {
    state.status = "signed_out";
    delete state.pending;
  }
  return { ok: true, status: state.status, authorized: state.status === "authorized", user: state.user };
}

/** Protected single-account login. Return null for routes owned by the parent. */
export async function handleTelegram(request: Request, env: TelegramEnv): Promise<Response | null> {
  const match = /^\/telegram\/(send-code|sign-in|status|logout)$/.exec(new URL(request.url).pathname);
  if (!match) return null;
  const action = match[1];
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: "setup_required", missing: ["ADMIN_TOKEN"] }, 503);
  const supplied = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
  const encoder = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(env.ADMIN_TOKEN)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const expected = new Uint8Array(expectedHash);
  const actual = new Uint8Array(suppliedHash);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
  if (difference !== 0) return json({ ok: false, error: "unauthorized" }, 401);
  const method = action === "status" ? "GET" : "POST";
  if (request.method !== method) return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: method });
  const missing = [
    !env.DB && "DB", !env.TELEGRAM_API_ID && "TELEGRAM_API_ID",
    !env.TELEGRAM_API_HASH && "TELEGRAM_API_HASH", !env.SESSION_ENCRYPTION_KEY && "SESSION_ENCRYPTION_KEY",
  ].filter((value): value is string => typeof value === "string");
  if (missing.length) return json({ ok: false, error: "setup_required", missing }, 503);
  if (!env.DB || !env.SESSION_ENCRYPTION_KEY || !env.TELEGRAM_API_HASH) return json({ ok: false, error: "setup_required" }, 503);
  const apiId = Number(env.TELEGRAM_API_ID);
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-f0-9]{32}$/i.test(env.TELEGRAM_API_HASH)) {
    return json({ ok: false, error: "setup_required", message: "Invalid Telegram API credentials configuration" }, 503);
  }
  const db = env.DB.withSession("first-primary");
  const owner = crypto.randomUUID();
  let locked = false;
  let client: TelegramClient | undefined;
  let timer: number | null = null;
  try {
    const body = method === "POST" ? await readBody(request) : {};
    const key = await sessionKey(env.SESSION_ENCRYPTION_KEY);
    const now = Date.now();
    const lock = await db.prepare("UPDATE telegram_session SET lock_owner = ?1, lock_until = ?2 WHERE id = 'primary' AND lock_until < ?3")
      .bind(owner, now + 120_000, now).run();
    if (lock.meta.changes !== 1) return json({ ok: false, error: "busy", retry_after: 2 }, 409, { "Retry-After": "2" });
    locked = true;
    const row = await db.prepare("SELECT ciphertext FROM telegram_session WHERE id = 'primary' AND lock_owner = ?1")
      .bind(owner).first<{ ciphertext: string | null }>();
    if (!row) throw new RouteError(503, "storage_unavailable", "Telegram session schema is unavailable");
    const state = await decodeState(row.ciphertext, key);
    // A failed sign-in may mutate client storage (for example during DC migration).
    // Only the expired-code reset, not those partial changes, may be persisted.
    const savedStorage = action === "sign-in" ? { ...state.storage } : null;
    let failOperation: (error: Error) => void = () => {};
    const failure = new Promise<never>((_resolve, reject) => { failOperation = reject; });
    timer = setTimeout(() => failOperation(new RouteError(504, "connection_failed", "Telegram operation timed out")), 30_000);
    const activeClient = new TelegramClient(apiId, env.TELEGRAM_API_HASH, {
      get: (name) => state.storage[name] ?? null,
      set: (name, value) => { state.storage[name] = value; },
    }, failOperation);
    client = activeClient;
    let result: Record<string, unknown>;
    let responseStatus = 200;
    try {
      result = await Promise.race([(async () => {
        let response: Record<string, unknown>;
        try {
          response = await operate(action, body, state, activeClient);
        } catch (error) {
          // RPC errors are server responses too; retire their message IDs.
          if (isTelegramRpcError(error)) await activeClient.flushAcknowledgments();
          throw error;
        }
        await activeClient.flushAcknowledgments();
        return response;
      })(), failure]);
    } catch (error) {
      if (error instanceof TelegramAuthKeyInvalidError) {
        state.storage = {};
        state.status = "signed_out";
        delete state.pending;
        delete state.user;
        if (action === "status") {
          result = { ok: true, status: "signed_out", authorized: false };
        } else {
          responseStatus = 401;
          result = {
            ok: false, error: "auth_key_invalid",
            message: "Telegram session expired. Send a new login code.",
            status: "signed_out", authorized: false,
          };
        }
      } else if (savedStorage && isTelegramRpcError(error) && error.error_message === "PHONE_CODE_EXPIRED") {
        state.storage = savedStorage;
        state.status = "signed_out";
        delete state.pending;
        delete state.user;
        responseStatus = 409;
        result = {
          ok: false, error: "code_expired",
          message: "Telegram login code expired. Send a new login code.",
          status: "signed_out", authorized: false,
        };
      } else {
        // Connectivity errors and other failed transitions leave the saved session untouched.
        throw error;
      }
    }
    client.close();
    clearTimeout(timer);
    const ciphertext = state.status === "signed_out" && Object.keys(state.storage).length === 0 ? null : await encodeState(state, key);
    const saved = await db.prepare("UPDATE telegram_session SET ciphertext = ?1, updated_at = ?2 WHERE id = 'primary' AND lock_owner = ?3 AND lock_until > ?2")
      .bind(ciphertext, Date.now(), owner).run();
    if (saved.meta.changes !== 1) throw new RouteError(409, "busy", "Telegram session ownership expired");
    return json(result, responseStatus);
  } catch (error) {
    if (error instanceof RouteError) return json({ ok: false, error: error.code, message: error.message }, error.statusCode);
    if (isTelegramRpcError(error)) {
      const message = /^[A-Z0-9_]{1,80}$/.test(error.error_message) ? error.error_message : "TELEGRAM_RPC_ERROR";
      const flood = /^FLOOD_WAIT_(\d+)$/.exec(message);
      return json({ ok: false, error: "telegram_error", message, ...(flood ? { retry_after: Number(flood[1]) } : {}) }, flood ? 429 : 400);
    }
    // No exception payload, auth key, OTP, phone, API hash or password is logged.
    return json({ ok: false, error: "connection_failed", message: "Telegram operation or session storage failed" }, 502);
  } finally {
    clearTimeout(timer);
    client?.close();
    if (locked) {
      await db.prepare("UPDATE telegram_session SET lock_owner = NULL, lock_until = 0 WHERE id = 'primary' AND lock_owner = ?1")
        .bind(owner).run().catch(() => {});
    }
  }
}
