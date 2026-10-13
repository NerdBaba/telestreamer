// Known safe prime pinned in Telegram's auth_key specification and core 6.3.0.
export const TELEGRAM_DH_PRIME = "c71caeb9c6b1c9048e6c522f70f13f73980d40238e3e21c14934d037563d930f48198a0aa7c14058229493d22530f4dbfa336f6e0ac925139543aed44cce7c3720fd51f69458705ac68cd4fe6b6b13abdc9746512969328454f18faf8c595f642477fe96bb2a941d5bcd1d4ac8cc49880708fa9b378e3c4f3a9060bee67cf9a4a4a695811051907e162753b56b0f6b410dba74d8a84b2a14b3144e0ef1284754fd17ed950d5965b4b9dd46582db1178d169c6bc465b0d6ff9ca3928fef5b9ae4e418fc15e83ebea0f87fa9ff5eed70050ded2849f47bf959d956850ce929851f0d8115f635b105ee2e4e15d04b2454bf6f4fadf034b10403119cd8e3b92fcc5b";

export interface SrpParameters { g: number; p: Uint8Array; salt1: Uint8Array; salt2: Uint8Array; gB: Uint8Array }
export interface SrpProof { A: Uint8Array; M1: Uint8Array }

function integer(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function padded(value: bigint): Uint8Array {
  const bytes = new Uint8Array(256);
  for (let i = bytes.length - 1; i >= 0; i--) { bytes[i] = Number(value & 255n); value >>= 8n; }
  if (value !== 0n) throw new Error("SRP integer exceeds 2048 bits");
  return bytes;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = result * base % modulus;
    exponent >>= 1n;
    base = base * base % modulus;
  }
  return result;
}

async function hash(...parts: Uint8Array[]): Promise<Uint8Array> {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer));
}

/** https://core.telegram.org/api/srp: every hashed integer is padded to 256 bytes. */
export async function createSrpProof(params: SrpParameters, password: string): Promise<SrpProof> {
  const { g, p: pBytes, salt1, salt2, gB } = params;
  const p = integer(pBytes);
  if (pBytes.length !== 256 || p.toString(16) !== TELEGRAM_DH_PRIME) throw new Error("Unsupported SRP prime");
  const goodGenerator = (g === 2 && p % 8n === 7n) || (g === 3 && p % 3n === 2n) || g === 4
    || (g === 5 && [1n, 4n].includes(p % 5n)) || (g === 6 && [19n, 23n].includes(p % 24n))
    || (g === 7 && [3n, 5n, 6n].includes(p % 7n));
  if (!goodGenerator) throw new Error("Invalid SRP generator");
  const B = integer(gB);
  if (gB.length > 256 || B <= 0n || B >= p) throw new Error("Invalid server SRP value");
  const gBytes = padded(BigInt(g));
  const BBytes = padded(B);
  const passwordBytes = new TextEncoder().encode(password);
  const ph1 = await hash(salt2, await hash(salt1, passwordBytes, salt1), salt2);
  const key = await crypto.subtle.importKey("raw", ph1, "PBKDF2", false, ["deriveBits"]);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({
    name: "PBKDF2", hash: "SHA-512", salt: salt1, iterations: 100000,
  }, key, 512));
  const x = integer(await hash(salt2, derived, salt2));
  const k = integer(await hash(pBytes, gBytes));
  const t = ((B - k * modPow(BigInt(g), x, p)) % p + p) % p;
  const bound = 1n << 1984n;
  if (t < bound || t > p - bound) throw new Error("Unsafe server SRP value");
  let a: bigint;
  let A: bigint;
  do {
    a = integer(crypto.getRandomValues(new Uint8Array(256)));
    A = modPow(BigInt(g), a, p);
  } while (A < bound || A > p - bound);
  const ABytes = padded(A);
  const u = integer(await hash(ABytes, BBytes));
  if (u === 0n) throw new Error("Invalid SRP scrambling parameter");
  const K = await hash(padded(modPow(t, a + u * x, p)));
  const [pHash, gHash, salt1Hash, salt2Hash] = await Promise.all([hash(pBytes), hash(gBytes), hash(salt1), hash(salt2)]);
  for (let i = 0; i < pHash.length; i++) pHash[i] ^= gHash[i];
  return { A: ABytes, M1: await hash(pHash, salt1Hash, salt2Hash, ABytes, BBytes, K) };
}
