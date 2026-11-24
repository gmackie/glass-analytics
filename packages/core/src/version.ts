/**
 * The Dataflare release version. Reported by the Worker's /health endpoint and
 * compared to the latest `dataflare` on npm. Must match
 * `packages/cli/package.json` — `pnpm build` enforces that.
 */
export const GLASS_VERSION = '0.9.1';

/**
 * This fork publishes its packages as @gmacko/dataflare-* on the private ForgeGraph registry, so
 * its versions never mix with upstream's dataflare-* on npm (DATFLR-27). A project reaches them
 * through this scope line in its .npmrc, which `dataflare init` and `client-init` add.
 */
export const PACKAGE_REGISTRY = 'https://npm.forgegraf.com/';
export const NPMRC_SCOPE_LINE = `@gmacko:registry=${PACKAGE_REGISTRY}`;

/** Canonical command to bring a deployment up to date. */
export const UPGRADE_COMMAND = 'npx @gmacko/dataflare-cli@latest upgrade';

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
