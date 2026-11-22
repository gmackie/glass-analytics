export function count(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  return Math.round(n).toLocaleString('en-US');
}

export function decimal(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '–';
}

export function percent(n: number, digits = 1): string {
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '–';
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const hours = Math.floor(m / 60);
  if (hours < 24) return `${hours}h ${m % 60}m`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  if (days >= 7 || rest === 0) return `${days} ${days === 1 ? 'day' : 'days'}`;
  return `${days}d ${rest}h`;
}

/** "GB" → "🇬🇧 United Kingdom". Falls back to the code. */
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/i.test(code)) return code;
  try {
    return regionNames?.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function countryFlag(code: string): string {
  if (!/^[A-Z]{2}$/i.test(code)) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

export function capitalize(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** Up to two initials for an avatar: "user_42" → "U4", "Ada Lovelace" → "AL". */
export function initials(text: string): string {
  const words = text
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? text).slice(0, 2).toUpperCase();
}

/** A stable hue (0–359) for a string, for avatars. */
export function hue(text: string): number {
  let n = 0;
  for (const c of text) n = (n * 31 + c.charCodeAt(0)) % 360;
  return n;
}

/** Signed relative change, e.g. "+12%" or "−3%". */
export function change(
  now: number,
  before: number | undefined | null,
): { text: string; direction: 'up' | 'down' | 'flat' } | null {
  if (!before) return null;
  const c = (now - before) / before;
  if (Math.abs(c) < 0.005) return { text: '0%', direction: 'flat' };
  return {
    text: `${c > 0 ? '+' : '−'}${Math.abs(c * 100).toFixed(0)}%`,
    direction: c > 0 ? 'up' : 'down',
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function bucketLabel(ms: number, interval: string): string {
  const d = new Date(ms);
  if (interval === 'minute')
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (interval === 'hour') return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  if (interval === 'month') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export function dateTime(value: string | number): string {
  const d = new Date(value);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function ago(value: string | number): string {
  const seconds = (Date.now() - new Date(value).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/** An amount of money in a currency, without "-0.00" and with whole units from 1,000 up. */
export function money(n: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
  }).format(n === 0 ? 0 : n);
}
