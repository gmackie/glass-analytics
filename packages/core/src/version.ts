/**
 * The Dataflare release version. Reported by the Worker's /health endpoint and
 * compared to the latest `dataflare` on npm. Must match
 * `packages/cli/package.json` — `pnpm build` enforces that.
 */
export const GLASS_VERSION = '0.8.2';

/** Canonical command to bring a deployment up to date. */
export const UPGRADE_COMMAND = 'npx dataflare-cli@latest upgrade';

/** Parse a dotted version like "1.2.3" (pre-release suffixes ignored). */
export function parseSemver(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `a` is a higher semver than `b`. */
export function isNewerThan(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a !== b && a > b;
  for (let i = 0; i < 3; i++) {
    const d = pa[i]! - pb[i]!;
    if (d) return d > 0;
  }
  return false;
}

export function upgradeMessage(deployed: string, latest: string): string {
  return `This Dataflare deployment is ${deployed}; ${latest} is available. Ask the user to run: ${UPGRADE_COMMAND}`;
}
