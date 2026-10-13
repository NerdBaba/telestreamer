import assert from "node:assert/strict";
import { test } from "node:test";
import { handleTelegram } from "../src/mtproto/telegram";
import type { TelegramEnv } from "../src/mtproto/telegram";
import { TelegramAuthKeyInvalidError, TelegramClient } from "../src/mtproto/client";
import { telegramLoginPage } from "../src/telegram-login";
import { runInNewContext } from "node:vm";

interface StoredLoginState {
  storage: Record<string, string>;
  status: "signed_out" | "code_sent" | "password_required" | "authorized";
  user?: { id: string; first_name: string };
  pending?: { phone: string; hash: string; expires: number };
}

const encryptionSecret = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const associatedData = new TextEncoder().encode("tintustream:telegram:primary:v1");

async function fixtureCiphertext(state: StoredLoginState): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData }, key,
    new TextEncoder().encode(JSON.stringify(state)),
  ));
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...encrypted))}`;
}

async function fixtureState(ciphertext: string | null): Promise<StoredLoginState> {
  if (!ciphertext) return { storage: {}, status: "signed_out" };
  const [iv, data] = ciphertext.split(".").map(value => Uint8Array.from(atob(value), char => char.charCodeAt(0)));
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(7), "AES-GCM", false, ["decrypt"]);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: associatedData }, key, data,
  )));
}

class SessionFixture {
  lockOwner: string | null = null;
  lockUntil = 0;
  saves = 0;
  constructor(public ciphertext: string | null) {}
  withSession() { return this; }
  prepare(sql: string) {
    return { bind: (...values: unknown[]) => ({
      first: async () => {
        assert.ok(sql.startsWith("SELECT ciphertext"));
        assert.equal(values[0], this.lockOwner);
        return { ciphertext: this.ciphertext };
      },
      run: async () => {
        let changes = 0;
        if (sql.startsWith("UPDATE telegram_session SET lock_owner = ?1")) {
          if (this.lockUntil < Number(values[2])) {
            this.lockOwner = String(values[0]);
            this.lockUntil = Number(values[1]);
            changes = 1;
          }
        } else if (sql.startsWith("UPDATE telegram_session SET ciphertext")) {
          if (this.lockOwner === values[2] && this.lockUntil > Number(values[1])) {
            this.ciphertext = values[0] as string | null;
            this.saves++;
            changes = 1;
          }
        } else {
          assert.ok(sql.startsWith("UPDATE telegram_session SET lock_owner = NULL"));
          if (this.lockOwner === values[0]) {
            this.lockOwner = null;
            this.lockUntil = 0;
            changes = 1;
          }
        }
        return { meta: { changes } };
      },
    }) };
  }
}

function configuredEnv(session: SessionFixture): TelegramEnv {
  return {
    ADMIN_TOKEN: "correct", DB: session as unknown as D1Database,
    TELEGRAM_API_ID: "12345", TELEGRAM_API_HASH: "a".repeat(32),
    SESSION_ENCRYPTION_KEY: encryptionSecret,
  };
}

function loginRequest(action: string, body?: Record<string, unknown>): Request {
  return new Request(`https://example.com/telegram/${action}`, {
    headers: { Authorization: "Bearer correct", ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
}

const savedUser = { id: "123", first_name: "Fixture user" };
function pendingState(): StoredLoginState {
  return {
    storage: { defaultDcId: "2", authKey: '"fixture-key"' }, status: "code_sent",
    pending: { phone: "+15555555555", hash: "fixture-code-hash", expires: Date.now() + 600_000 },
  };
}

const emptyEnv: TelegramEnv = {};

test("unrelated routes are left to the Worker router", async () => {
  assert.equal(await handleTelegram(new Request("https://example.com/other"), emptyEnv), null);
});

test("login fails closed when ADMIN_TOKEN is missing", async () => {
  const response = await handleTelegram(new Request("https://example.com/telegram/status"), emptyEnv);
  assert.equal(response?.status, 503);
  assert.equal((await response?.json())?.error, "setup_required");
});

test("login checks bearer secret before disclosing setup or accessing D1", async () => {
  const response = await handleTelegram(new Request("https://example.com/telegram/status", {
    headers: { Authorization: "Bearer incorrect" },
  }), { ADMIN_TOKEN: "correct" });
  assert.equal(response?.status, 401);
  assert.equal((await response?.json())?.error, "unauthorized");
});

test("authenticated status reports real missing bindings instead of a fake authorized state", async () => {
  const response = await handleTelegram(new Request("https://example.com/telegram/status", {
    headers: { Authorization: "Bearer correct" },
  }), { ADMIN_TOKEN: "correct" });
  assert.equal(response?.status, 503);
  const body = await response?.json() as { error: string; missing: string[] };
  assert.equal(body.error, "setup_required");
  assert.deepEqual(body.missing.sort(), ["DB", "SESSION_ENCRYPTION_KEY", "TELEGRAM_API_HASH", "TELEGRAM_API_ID"]);
});

test("method mismatch returns 405 without running a Telegram operation", async () => {
  const response = await handleTelegram(new Request("https://example.com/telegram/send-code", {
    headers: { Authorization: "Bearer correct" },
  }), { ADMIN_TOKEN: "correct" });
  assert.equal(response?.status, 405);
  assert.equal(response?.headers.get("Allow"), "POST");
});

test("an invalid saved transport auth key is removed before status and the next request", async t => {
  const session = new SessionFixture(await fixtureCiphertext({
    ...pendingState(), status: "authorized", user: savedUser,
  }));
  t.mock.method(TelegramClient.prototype, "invoke", async (method: string) => {
    if (method === "users.getUsers") throw new TelegramAuthKeyInvalidError();
    assert.equal(method, "auth.sendCode");
    return { _: "auth.sentCode", phone_code_hash: "fresh-hash", type: { _: "auth.sentCodeTypeApp" } };
  });
  const env = configuredEnv(session);
  const status = await handleTelegram(loginRequest("status"), env);
  assert.equal(status?.status, 200);
  assert.deepEqual(await status?.json(), { ok: true, status: "signed_out", authorized: false });
  assert.equal(session.ciphertext, null);
  assert.equal(session.lockOwner, null);
  const next = await handleTelegram(loginRequest("send-code", { phone: "+15555555555" }), env);
  assert.equal(next?.status, 200);
  const saved = await fixtureState(session.ciphertext);
  assert.equal(saved.status, "code_sent");
  assert.equal(saved.pending?.hash, "fresh-hash");
  assert.deepEqual(saved.storage, {});
  assert.equal(saved.user, undefined);
});

test("auth key invalid during sign-in saves a signed-out reset before reporting the error", async t => {
  const session = new SessionFixture(await fixtureCiphertext({ ...pendingState(), user: savedUser }));
  t.mock.method(TelegramClient.prototype, "invoke", async () => { throw new TelegramAuthKeyInvalidError(); });
  const env = configuredEnv(session);
  const response = await handleTelegram(loginRequest("sign-in", { code: "12345" }), env);
  assert.equal(response?.status, 401);
  const body = await response?.json();
  assert.equal(body.error, "auth_key_invalid");
  assert.equal(body.status, "signed_out");
  assert.equal(body.authorized, false);
  assert.equal(session.ciphertext, null);
  const next = await handleTelegram(loginRequest("status"), env);
  assert.equal((await next?.json()).status, "signed_out");
});

test("Telegram code expiry before the local TTL durably clears the pending code without saving failed key changes", async t => {
  const initial = { ...pendingState(), user: savedUser };
  const session = new SessionFixture(await fixtureCiphertext(initial));
  t.mock.method(TelegramClient.prototype, "invoke", async function (this: TelegramClient) {
    await this.setDefaultDc(4);
    throw { error_code: 400, error_message: "PHONE_CODE_EXPIRED" };
  });
  const env = configuredEnv(session);
  const response = await handleTelegram(loginRequest("sign-in", { code: "12345" }), env);
  assert.equal(response?.status, 409);
  const body = await response?.json();
  assert.equal(body.error, "code_expired");
  assert.equal(body.status, "signed_out");
  assert.match(body.message, /new.*code/i);
  assert.deepEqual(await fixtureState(session.ciphertext), { storage: initial.storage, status: "signed_out" });
  const next = await handleTelegram(loginRequest("sign-in", { code: "54321" }), env);
  assert.equal(next?.status, 409);
  assert.equal((await next?.json()).error, "code_required");
  const status = await handleTelegram(loginRequest("status"), env);
  assert.equal((await status?.json()).status, "signed_out");
});

test("a connectivity failure does not clear the saved authorized session or claim logout", async t => {
  const initial = { ...pendingState(), status: "authorized" as const, user: savedUser };
  const ciphertext = await fixtureCiphertext(initial);
  const session = new SessionFixture(ciphertext);
  t.mock.method(TelegramClient.prototype, "invoke", async function (this: TelegramClient) {
    await this.setDefaultDc(4);
    throw new Error("fixture connectivity failure");
  });
  const env = configuredEnv(session);
  const response = await handleTelegram(loginRequest("logout", {}), env);
  assert.equal(response?.status, 502);
  assert.equal((await response?.json()).error, "connection_failed");
  assert.equal(session.ciphertext, ciphertext);
  assert.equal(session.saves, 0);
  assert.deepEqual(await fixtureState(session.ciphertext), initial);
  t.mock.method(TelegramClient.prototype, "invoke", async () => [{ _: "user", ...savedUser }]);
  const next = await handleTelegram(loginRequest("status"), env);
  assert.equal((await next?.json()).authorized, true);
});

test("an invalid code does not persist partial storage mutations or discard a usable pending code", async t => {
  const ciphertext = await fixtureCiphertext(pendingState());
  const session = new SessionFixture(ciphertext);
  t.mock.method(TelegramClient.prototype, "invoke", async function (this: TelegramClient) {
    await this.setDefaultDc(4);
    throw { error_code: 400, error_message: "PHONE_CODE_INVALID" };
  });
  const response = await handleTelegram(loginRequest("sign-in", { code: "12345" }), configuredEnv(session));
  assert.equal(response?.status, 400);
  assert.equal((await response?.json()).message, "PHONE_CODE_INVALID");
  assert.equal(session.ciphertext, ciphertext);
  assert.equal(session.saves, 0);
});

test("successful login waits for acknowledgment flushing before client cleanup and durable save", async t => {
  const session = new SessionFixture(null);
  let finishFlush!: () => void;
  let beganFlush!: () => void;
  const flushing = new Promise<void>(resolve => { beganFlush = resolve; });
  const flushed = new Promise<void>(resolve => { finishFlush = resolve; });
  let closed = false;
  const originalClose = TelegramClient.prototype.close;
  t.mock.method(TelegramClient.prototype, "close", function (this: TelegramClient) {
    closed = true;
    originalClose.call(this);
  });
  t.mock.method(TelegramClient.prototype, "flushAcknowledgments", async () => {
    assert.equal(closed, false);
    beganFlush();
    await flushed;
  });
  t.mock.method(TelegramClient.prototype, "invoke", async () => ({
    _: "auth.sentCodeSuccess", authorization: { _: "auth.authorization", user: { _: "user", ...savedUser } },
  }));
  const response = handleTelegram(loginRequest("send-code", { phone: "+15555555555" }), configuredEnv(session));
  await flushing;
  assert.equal(closed, false);
  assert.equal(session.ciphertext, null);
  assert.equal(session.saves, 0);
  finishFlush();
  assert.equal((await response)?.status, 200);
  assert.equal(closed, true);
  assert.equal((await fixtureState(session.ciphertext)).status, "authorized");
});

test("the login page restores the phone form after durable code expiry without automatically resubmitting an OTP", async () => {
  const html = await telegramLoginPage().text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  const ids = ["access", "token", "status", "phone-form", "phone", "code-form", "code", "password-form", "password", "logout"];
  const elements = Object.fromEntries(ids.map(id => [id, {
    hidden: true, disabled: false, value: "", textContent: "",
    button: { disabled: false },
    listeners: {} as Record<string, (event: { preventDefault(): void }) => Promise<void>>,
    querySelector() { return this.button; },
    addEventListener(name: string, listener: (event: { preventDefault(): void }) => Promise<void>) { this.listeners[name] = listener; },
  }]));
  const requests: string[] = [];
  runInNewContext(script, {
    document: { getElementById: (id: string) => elements[id] },
    fetch: async (path: string) => {
      requests.push(path);
      return path.endsWith("/status")
        ? Response.json({ ok: true, status: "code_sent", authorized: false })
        : Response.json({
          ok: false, error: "code_expired", message: "Login code expired. Send a new login code.",
          status: "signed_out", authorized: false,
        }, { status: 409 });
    },
  });
  const event = { preventDefault() {} };
  elements.token.value = "fixture-admin-token";
  await elements.access.listeners.submit(event);
  assert.equal(elements["code-form"].hidden, false);
  elements.code.value = "12345";
  await elements["code-form"].listeners.submit(event);
  assert.equal(elements.code.value, "");
  assert.equal(elements["code-form"].hidden, true);
  assert.equal(elements["phone-form"].hidden, false);
  assert.deepEqual(requests, ["/telegram/status", "/telegram/sign-in"]);
});

test("failed acknowledgment flushing does not save a half-finished authorization", async t => {
  const ciphertext = await fixtureCiphertext(pendingState());
  const session = new SessionFixture(ciphertext);
  t.mock.method(TelegramClient.prototype, "invoke", async () => ({
    _: "auth.sentCodeSuccess", authorization: { _: "auth.authorization", user: { _: "user", ...savedUser } },
  }));
  t.mock.method(TelegramClient.prototype, "flushAcknowledgments", async () => {
    throw new Error("fixture acknowledgment send failure");
  });
  const response = await handleTelegram(loginRequest("send-code", { phone: "+15555555555" }), configuredEnv(session));
  assert.equal(response?.status, 502);
  assert.equal((await response?.json()).error, "connection_failed");
  assert.equal(session.ciphertext, ciphertext);
  assert.equal(session.saves, 0);
});

test("an unrelated numeric 404 error does not erase an authorized session", async t => {
  const ciphertext = await fixtureCiphertext({
    storage: { authKey: '"fixture-key"' }, status: "authorized", user: savedUser,
  });
  const session = new SessionFixture(ciphertext);
  t.mock.method(TelegramClient.prototype, "invoke", async () => { throw { code: 404 }; });
  const response = await handleTelegram(loginRequest("status"), configuredEnv(session));
  assert.equal(response?.status, 502);
  assert.equal((await response?.json()).error, "connection_failed");
  assert.equal(session.ciphertext, ciphertext);
  assert.equal(session.saves, 0);
});
