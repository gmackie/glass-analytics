/**
 * Google service-account access tokens (OAuth 2.0 JWT bearer flow) with
 * WebCrypto, for BigQuery batch exports. No Google SDK needed.
 */

export interface ServiceAccount {
  client_email: string;
  /** The PEM-armoured PKCS#8 private key, as in the key JSON Google gives you. */
  private_key: string;
  token_uri?: string;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A signed JWT asserting the service account, for the token endpoint. */
export async function serviceAccountAssertion(
  sa: ServiceAccount,
  scope: string,
  now = Date.now(),
): Promise<string> {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    }),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    encoder.encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64url(new Uint8Array(signature))}`;
}

/** Exchange the assertion for an access token. */
const tokens = new Map<string, { token: string; until: number }>();

/** An access token for a service account, reused until a minute before it expires. */
export async function googleAccessToken(
  sa: ServiceAccount,
  scope: string,
  fetcher: typeof fetch = (i, init) => fetch(i, init),
): Promise<string> {
  const cacheKey = `${sa.client_email}\u0000${scope}`;
  const hit = tokens.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.token;
  const assertion = await serviceAccountAssertion(sa, scope);
  const res = await fetcher(sa.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token exchange failed: ${body.error_description ?? res.status}`);
  }
  tokens.set(cacheKey, {
    token: body.access_token,
    until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
  });
  return body.access_token;
}
