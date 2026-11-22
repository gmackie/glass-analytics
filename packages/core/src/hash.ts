/**
 * Hashing helpers.
 *
 * `fnv1a32` is used for feature-flag bucketing: it is tiny, synchronous and
 * identical in every runtime, which matters because the SDK, the Worker and
 * your own server code must all put a user in the same bucket.
 */

const encoder = new TextEncoder();

/** 32-bit FNV-1a over the UTF-8 bytes of `input`. Returns an unsigned integer. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (const byte of encoder.encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Hex SHA-256 via WebCrypto. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Hex HMAC-SHA-256 of `message` under `key`, via WebCrypto (Workers, browsers, Node). */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The server key: what backends use to import history, fetch flag definitions for local
 * evaluation and upload source maps. It can't read analytics or change settings. It is derived
 * from the admin key (so CI upgrades, which can't set new Worker secrets, still have one) unless
 * a deployment sets GLASS_SERVER_KEY explicitly.
 */
export async function deriveServerKey(adminKey: string): Promise<string> {
  return `srv_${(await hmacSha256Hex(adminKey, 'dataflare:server-key:v1')).slice(0, 40)}`;
}

/** Constant-time string comparison, for API keys. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
