/**
 * Generates packages/dashboard/src/components/world-paths.ts: country outlines
 * for the dashboard's world map, keyed by ISO 3166-1 alpha-2 code.
 *
 * Source: Natural Earth 1:110m countries (public domain) as packaged by
 * world-atlas 2.0.2 (ISC), and ISO numeric → alpha-2 codes from
 * i18n-iso-countries 7.11.0 (MIT). Both are fetched at the pinned versions.
 * The outlines are projected with the Natural Earth projection, simplified,
 * and written as integer SVG paths, so the dashboard needs no map library.
 *
 *   node scripts/world-map.ts
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ATLAS = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';
const CODES = 'https://cdn.jsdelivr.net/npm/i18n-iso-countries@7.11.0/codes.json';
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'dashboard',
  'src',
  'components',
  'world-paths.ts',
);
const WIDTH = 2000;
/** Douglas–Peucker tolerance, in output units (a 2000-wide map). */
const TOLERANCE = 0.9;

type Point = [number, number];
interface Topology {
  transform: { scale: [number, number]; translate: [number, number] };
  arcs: Point[][];
  objects: {
    countries: {
      geometries: {
        type: 'Polygon' | 'MultiPolygon';
        arcs: number[][] | number[][][];
        id?: string;
        properties: { name: string };
      }[];
    };
  };
}

const [topology, codes] = (await Promise.all(
  [ATLAS, CODES].map(async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }),
)) as [Topology, [string, string, string][]];

const alpha2 = new Map(codes.map(([a2, , numeric]) => [numeric, a2]));
// Natural Earth features without an ISO numeric code.
const BY_NAME: Record<string, string> = { Kosovo: 'XK' };

// Delta-decode the quantized arcs into longitude/latitude.
const { scale, translate } = topology.transform;
const arcs = topology.arcs.map((arc) => {
  let x = 0;
  let y = 0;
  return arc.map(([dx, dy]): Point => {
    x += dx;
    y += dy;
    return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
  });
});

function ring(indices: number[]): Point[] {
  const out: Point[] = [];
  for (const index of indices) {
    const arc = index < 0 ? [...arcs[~index]!].reverse() : arcs[index]!;
    out.push(...(out.length ? arc.slice(1) : arc));
  }
  return out;
}

/** Keep the part of a ring on one side of a meridian (Sutherland–Hodgman against a vertical line). */
function clip(points: Point[], at: number, keepBelow: boolean): Point[] {
  const inside = (p: Point) => (keepBelow ? p[0] <= at : p[0] >= at);
  const out: Point[] = [];
  points.forEach((current, i) => {
    const previous = points[(i + points.length - 1) % points.length]!;
    const cross = (): Point => {
      const t = (at - previous[0]) / (current[0] - previous[0]);
      return [at, previous[1] + t * (current[1] - previous[1])];
    };
    if (inside(current)) {
      if (!inside(previous)) out.push(cross());
      out.push(current);
    } else if (inside(previous)) out.push(cross());
  });
  return out;
}

/**
 * Rings that cross the 180° meridian (Fiji, Chukotka) jump from +180 to −180.
 * Unwrap them, then cut at the meridian into a piece on each side.
 */
function splitAtAntimeridian(points: Point[]): Point[][] {
  const unwrapped: Point[] = [];
  for (const [lon, lat] of points) {
    let x = lon;
    const prev = unwrapped[unwrapped.length - 1];
    if (prev) {
      while (x - prev[0] > 180) x -= 360;
      while (x - prev[0] < -180) x += 360;
    }
    unwrapped.push([x, lat]);
  }
  const min = Math.min(...unwrapped.map((p) => p[0]));
  const max = Math.max(...unwrapped.map((p) => p[0]));
  if (max <= 180 && min >= -180) return [points];
  const edge = max > 180 ? 180 : -180;
  const shift = max > 180 ? -360 : 360;
  const near = clip(unwrapped, edge, max > 180);
  const far = clip(unwrapped, edge, max <= 180).map(([x, y]): Point => [x + shift, y]);
  return [near, far].filter((r) => r.length >= 3);
}

/** Natural Earth projection (Šavrič, Jenny, Patterson and Jenny, 2011). */
function project([lon, lat]: Point): Point {
  const l = (lon * Math.PI) / 180;
  const p = (lat * Math.PI) / 180;
  const p2 = p * p;
  const p4 = p2 * p2;
  return [
    l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
    p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
  ];
}

function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 4) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a]!;
    const [bx, by] = points[b]!;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i]!;
      const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A closed ring starts and ends at the same point, so split it at the point farthest from the start. */
function simplifyRing(points: Point[], tolerance: number): Point[] {
  const [sx, sy] = points[0]!;
  let far = 0;
  let best = -1;
  points.forEach(([x, y], i) => {
    const d = Math.hypot(x - sx, y - sy);
    if (d > best) {
      best = d;
      far = i;
    }
  });
  if (far === 0) return points;
  return [
    ...simplify(points.slice(0, far + 1), tolerance),
    ...simplify(points.slice(far), tolerance).slice(1),
  ];
}

const area = (points: Point[]) =>
  Math.abs(
    points.reduce((sum, [x, y], i) => {
      const [nx, ny] = points[(i + 1) % points.length]!;
      return sum + x * ny - nx * y;
    }, 0) / 2,
  );

// Every country's rings, projected (Antarctica left out: it takes room and holds no visitors).
const countries = topology.objects.countries.geometries
  .filter((g) => g.id !== '010')
  .map((g, i) => {
    const polygons = (g.type === 'Polygon' ? [g.arcs] : g.arcs) as number[][][];
    const code = (g.id && alpha2.get(g.id)) ?? BY_NAME[g.properties.name] ?? `_${i}`;
    return {
      code,
      name: g.properties.name,
      rings: polygons.flatMap((polygon) =>
        polygon.flatMap((r) => splitAtAntimeridian(ring(r)).map((piece) => piece.map(project))),
      ),
    };
  });

const all = countries.flatMap((c) => c.rings.flat());
const minX = Math.min(...all.map((p) => p[0]));
const maxX = Math.max(...all.map((p) => p[0]));
const minY = Math.min(...all.map((p) => p[1]));
const maxY = Math.max(...all.map((p) => p[1]));
const k = WIDTH / (maxX - minX);
const HEIGHT = Math.ceil((maxY - minY) * k);
const toScreen = ([x, y]: Point): Point => [(x - minX) * k, (maxY - y) * k];

const paths: Record<string, string> = {};
for (const c of countries) {
  const rings = c.rings
    .map((r) => simplifyRing(r.map(toScreen), TOLERANCE))
    .map((r) => {
      // Integer points, without repeats.
      const out: Point[] = [];
      for (const [x, y] of r) {
        const p: Point = [Math.round(x), Math.round(y)];
        const last = out[out.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
      }
      return out;
    })
    .filter((r) => r.length >= 3);
  // Drop specks, but keep at least the largest ring of every country.
  const largest = Math.max(...rings.map(area));
  const kept = rings.filter((r) => area(r) >= 6 || area(r) === largest);
  const d = kept
    .map((r) => {
      let [px, py] = r[0]!;
      const steps = r.slice(1).map(([x, y]) => {
        const step = `${x - px} ${y - py}`;
        px = x;
        py = y;
        return step;
      });
      return `M${r[0]![0]} ${r[0]![1]}l${steps.join(' ')}z`;
    })
    .join('')
    .replace(/ -/g, '-');
  if (d) paths[c.code] = (paths[c.code] ?? '') + d;
}

const body = Object.entries(paths)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([code, d]) => `  ${/^[A-Z]{2}$/.test(code) ? code : `'${code}'`}: '${d}',`)
  .join('\n');
writeFileSync(
  OUT,
  `/**
 * Country outlines for the world map, keyed by ISO 3166-1 alpha-2 code (keys
 * starting with "_" are territories without one). Natural Earth 1:110m
 * countries (public domain) via world-atlas 2.0.2 (ISC), in the Natural Earth
 * projection. Generated by scripts/world-map.ts: do not edit by hand.
 */

export const WORLD_WIDTH = ${WIDTH};
export const WORLD_HEIGHT = ${HEIGHT};

export const WORLD_PATHS: Record<string, string> = {
${body}
};
`,
);
console.log(
  `${Object.keys(paths).length} countries, ${WIDTH}×${HEIGHT}, ${(Buffer.byteLength(body) / 1024).toFixed(1)} KB → ${OUT}`,
);
