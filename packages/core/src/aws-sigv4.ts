/**
 * AWS Signature Version 4 for S3-compatible object stores (AWS S3, Cloudflare R2,
 * Backblaze B2, MinIO…), with WebCrypto only. Used by batch exports to PUT files.
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-signing.html
 */

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', k, encoder.encode(data));
}

/** RFC 3986 encoding as SigV4 wants it (path segments keep "/"). */
function uriEncode(s: string, keepSlash = false): string {
  return s
    .split('')
    .map((c) =>
      /[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')
        ? c
        : Array.from(
            encoder.encode(c),
            (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`,
          ).join(''),
    )
    .join('');
}

export interface SigV4Request {
  method: string;
  url: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** For tests: a fixed time. */
  now?: Date;
}

/** Headers to send with the request, including Authorization. */
export async function signSigV4(r: SigV4Request): Promise<Record<string, string>> {
  const url = new URL(r.url);
  const service = r.service ?? 's3';
  const now = r.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(r.body ?? new Uint8Array());
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  const signed = Object.keys(headers).sort();
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [
    r.method.toUpperCase(),
    uriEncode(decodeURIComponent(url.pathname), true),
    canonicalQuery,
    signed.map((k) => `${k}:${String(headers[k]).trim().replace(/\s+/g, ' ')}\n`).join(''),
    signed.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${date}/${r.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
  let key: ArrayBuffer = await hmac(encoder.encode(`AWS4${r.secretAccessKey}`), date);
  key = await hmac(key, r.region);
  key = await hmac(key, service);
  key = await hmac(key, 'aws4_request');
  const signature = hex(await hmac(key, toSign));
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
  };
}
