/**
 * A deliberately small user-agent parser.
 *
 * Analytics needs the browser family, OS family and a device class — not exact
 * versions — so a dozen ordered regexes beat a 100 KB UA database. Order
 * matters: Edge and Opera include "Chrome", Chrome includes "Safari".
 */

export interface ParsedUserAgent {
  browser: string;
  os: string;
  device: 'desktop' | 'mobile' | 'tablet' | 'bot' | 'unknown';
}

const BOT =
  /bot|crawler|spider|crawling|headless|lighthouse|pagespeed|preview|slurp|facebookexternalhit|monitor|curl|wget|python-requests|go-http-client|httpclient/i;

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser/, 'Samsung Internet'],
  [/Firefox\/|FxiOS/, 'Firefox'],
  [/CriOS|Chrome\/|Chromium/, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

export function isBot(ua: string): boolean {
  return !ua || BOT.test(ua);
}

export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  if (!ua) return { browser: '', os: '', device: 'unknown' };
  if (BOT.test(ua)) return { browser: 'Bot', os: '', device: 'bot' };
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? 'Other';
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? 'Other';
  const tablet = /iPad|Tablet/i.test(ua) || androidTablet(ua);
  // "Mobi" also covers Android phones, whose user agents say "Mobile".
  const mobile = !tablet && /Mobi|iPhone|iPod/i.test(ua);
  return { browser, os, device: tablet ? 'tablet' : mobile ? 'mobile' : 'desktop' };
}

/**
 * Android without "Mobile" after it is a tablet. A string search, not `/Android(?!.*Mobile)/`,
 * which backtracks badly on a user agent that repeats "Android".
 */
function androidTablet(ua: string): boolean {
  const lower = ua.toLowerCase();
  const at = lower.lastIndexOf('android');
  return at >= 0 && !lower.includes('mobile', at);
}
