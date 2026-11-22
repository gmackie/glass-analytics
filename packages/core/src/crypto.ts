/**
 * Secrets at rest: destination tokens and export credentials stored in D1 are
 * encrypted with AES-GCM. The key comes from GLASS_ENCRYPTION_KEY, or is derived
 * from the deployment's salt secret (so CI upgrades, which can't add Worker
 * secrets, still have one). Rotating that secret makes stored secrets unreadable:
 * re-enter them after a rotation.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const keys = new Map<string, Promise<CryptoKey>>();

/** An AES-256-GCM key from any secret string (SHA-256 of it, with a purpose label). */
export function secretKey(secret: string, purpose = 'dataflare:secrets:v1'): Promise<CryptoKey> {
  const id = `${purpose}\u0000${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = crypto.subtle
      .digest('SHA-256', encoder.encode(`${purpose}:${secret}`))
      .then((raw) =>
        crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
      );
    keys.set(id, key);
  }
  return key;
}

/** Encrypt a JSON value: base64 of a 12-byte IV followed by the ciphertext. */
export async function encryptJson(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = encoder.encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv);
  out.set(cipher, iv.length);
  return toBase64(out);
}

/** Decrypt what `encryptJson` produced. Throws when the key is wrong or the data was altered. */
export async function decryptJson<T = unknown>(key: CryptoKey, text: string): Promise<T> {
  const bytes = fromBase64(text);
  const iv = bytes.slice(0, 12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.slice(12));
  return JSON.parse(decoder.decode(plain)) as T;
}

/** Hex SHA-256, normalised as ad platforms want identifiers hashed (trimmed, lowercased). */
export async function sha256Normalised(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value.trim().toLowerCase()));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
