/**
 * Signed links: report chart images and email unsubscribe links are public URLs that only
 * work with a signature made from the deployment's secret (HKDF, one key per purpose), and
 * images expire. No new secret is needed: the key comes from the encryption key, or the salt
 * secret, as destination credentials do.
 */

import type { Env } from './env.ts';
import { HttpError } from './http.ts';

const keys = new Map<string, Promise<CryptoKey>>();

function secretOf(env: Env): string {
  const secret = env.GLASS_ENCRYPTION_KEY ?? env.GLASS_SALT_SECRET ?? env.GLASS_ADMIN_KEY;
  if (!secret) throw new HttpError(503, 'No secret to sign links with', 'Run `dataflare upgrade`.');
  return secret;
}

async function hmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('dataflare'),
      info: new TextEncoder().encode(purpose),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}

function keyFor(env: Env, purpose: string): Promise<CryptoKey> {
  const secret = secretOf(env);
  const id = `${purpose}\u0000${secret}`;
  let key = keys.get(id);
  if (!key) {
    key = hmacKey(secret, purpose);
    keys.set(id, key);
  }
  return key;
}

const b64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export async function sign(env: Env, purpose: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    'HMAC',
    await keyFor(env, purpose),
    new TextEncoder().encode(message),
  );
  return b64url(sig).slice(0, 32);
}

/** Constant-time comparison of a signature with the expected one. */
export async function verify(
  env: Env,
  purpose: string,
  message: string,
  signature: string,
): Promise<boolean> {
  const expected = await sign(env, purpose, message);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
