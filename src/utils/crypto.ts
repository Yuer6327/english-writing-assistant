// ============================================================
// crypto.ts — 密码哈希 (PBKDF2) + API Key 加密 (AES-GCM)
// ============================================================

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── Secret 存在性与强度检查（Fail-closed）──
// 缺失或过短的 JWT_SECRET / ENCRYPTION_KEY 会导致可伪造的 token / 可解密的 BYOK 密钥。
// 在签发/校验 token 与加解密 API Key 前先断言，服务不可用时直接抛错而非静默弱化。
export function assertStrongSecret(envKey: string, name: string): void {
  if (!envKey || envKey.length < 32) {
    throw new Error(`${name} 未配置或过短（至少 32 字符），请设置后重试`);
  }
}

// ── 工具：base64 ↔ ArrayBuffer ──
function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function randomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

// ── 密码哈希 PBKDF2 ──
export async function hashPassword(password: string, saltB64?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltB64
    ? new Uint8Array(b64ToBuf(saltB64))
    : randomBytes(16);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 5000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );

  return { hash: bufToB64(derived), salt: bufToB64(salt.buffer as ArrayBuffer) };
}

export async function verifyPassword(password: string, storedHash: string, saltB64: string): Promise<boolean> {
  const { hash } = await hashPassword(password, saltB64);
  return hash === storedHash;
}

// ── AES-GCM 加解密（用于 BYOK API Key）──
// 用 ENCRYPTION_KEY 的 SHA-256 作为 AES-256 密钥（确保 32 字节）
async function deriveAesKey(envKey: string): Promise<CryptoKey> {
  assertStrongSecret(envKey, 'ENCRYPTION_KEY');
  const hashBuf = await crypto.subtle.digest('SHA-256', enc.encode(envKey));
  return crypto.subtle.importKey('raw', hashBuf, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptApiKey(plainKey: string, envKey: string): Promise<string> {
  const key = await deriveAesKey(envKey);
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    enc.encode(plainKey),
  );
  return `${bufToB64(iv.buffer as ArrayBuffer)}:${bufToB64(ciphertext)}`;
}

export async function decryptApiKey(encrypted: string, envKey: string): Promise<string> {
  const [ivB64, ctB64] = encrypted.split(':');
  if (!ivB64 || !ctB64) throw new Error('Invalid encrypted key format');
  const key = await deriveAesKey(envKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBuf(ivB64) as BufferSource },
    key,
    b64ToBuf(ctB64),
  );
  return dec.decode(plaintext);
}
