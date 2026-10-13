import assert from "node:assert/strict";
import { createHash, pbkdf2Sync } from "node:crypto";
import { test } from "node:test";
import { createSrpProof, TELEGRAM_DH_PRIME } from "../src/mtproto/srp";

const prime = Buffer.from(TELEGRAM_DH_PRIME, "hex");
const p = BigInt(`0x${TELEGRAM_DH_PRIME}`);
const salt1 = Buffer.from("first salt");
const salt2 = Buffer.from("second salt");
const password = "test password";
const hash = (...bytes: Uint8Array[]) => createHash("sha256").update(Buffer.concat(bytes)).digest();
const number = (bytes: Uint8Array) => BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
function padded(value: bigint): Buffer { return Buffer.from(value.toString(16).padStart(512, "0"), "hex"); }
function power(base: bigint, exponent: bigint): bigint {
  let value = 1n;
  for (; exponent > 0n; exponent >>= 1n, base = base * base % p) {
    if (exponent & 1n) value = value * base % p;
  }
  return value;
}

test("2FA proof interoperates with an independent SRP server and pads A to 2048 bits", async () => {
  const g = padded(3n);
  const x = number(hash(salt2, pbkdf2Sync(hash(salt2, hash(salt1, Buffer.from(password), salt1), salt2), salt1, 100000, 64, "sha512"), salt2));
  const v = power(3n, x);
  const k = number(hash(prime, g));
  const b = 123456789n;
  const B = padded((k * v + power(3n, b)) % p);
  const proof = await createSrpProof({ g: 3, p: prime, salt1, salt2, gB: B }, password);
  assert.equal(proof.A.length, 256);
  const u = number(hash(proof.A, B));
  const serverSecret = power(number(proof.A) * power(v, u) % p, b);
  const xor = hash(prime).map((byte, i) => byte ^ hash(g)[i]);
  const expected = hash(xor, hash(salt1), hash(salt2), proof.A, B, hash(padded(serverSecret)));
  assert.deepEqual(Buffer.from(proof.M1), expected);
});

test("2FA rejects unsafe prime and invalid server B before hashing passwords", async () => {
  const params = { g: 3, p: prime, salt1, salt2, gB: new Uint8Array(256) };
  await assert.rejects(createSrpProof(params, password), /server SRP value/);
  await assert.rejects(createSrpProof({ ...params, p: new Uint8Array(256) }, password), /prime/);
  await assert.rejects(createSrpProof({ ...params, g: 1 }, password), /generator/);
});
