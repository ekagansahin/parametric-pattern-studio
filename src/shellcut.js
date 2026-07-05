// Shell perforation (Step 6): surface point sampling -> Voronoi cell walls /
// Delaunay wireframe -> SDF + levelSet -> intersection with the shell volume.
// Surface-seeded Euclidean Voronoi is used instead of geodesic Voronoi: since
// the seeds lie on the surface, the two coincide in practice within a thin
// shell, and the levelSet output is guaranteed manifold (far more robust than
// a chain of tube booleans).
// Pure functions — used in the worker and in Node tests.
import { boundsOf } from './stl.js';
import { toManifold, getMeshOf, volumeOf, offsetVertsInward } from './pipeline.js';

function codedError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Deterministic RNG (mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- sparse spatial grid ---------- */

const K = 2000, K0 = 500; // key range: cell index ±500
function gridKey(ix, iy, iz) {
  return ((ix + K0) * K + (iy + K0)) * K + (iz + K0);
}

class PointGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.map = new Map();
  }
  insert(idx, x, y, z) {
    const key = gridKey(
      Math.floor(x / this.cellSize),
      Math.floor(y / this.cellSize),
      Math.floor(z / this.cellSize)
    );
    let arr = this.map.get(key);
    if (!arr) { arr = []; this.map.set(key, arr); }
    arr.push(idx);
  }
  /** Calls cb with the point indices in the ±rings cells around (x,y,z). */
  forNeighbors(x, y, z, rings, cb) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    for (let dx = -rings; dx <= rings; dx++) {
      for (let dy = -rings; dy <= rings; dy++) {
        for (let dz = -rings; dz <= rings; dz++) {
          const arr = this.map.get(gridKey(cx + dx, cy + dy, cz + dz));
          if (arr) for (let i = 0; i < arr.length; i++) cb(arr[i]);
        }
      }
    }
  }
}

/* ---------- surface point sampling ---------- */

/**
 * Area-weighted dart-throwing (Poisson-disk-like) surface sampling.
 * @returns Float32Array (xyz * N) — distance between seeds >= ~0.9*spacing
 */
export function sampleSurfacePoints(vertProperties, triVerts, spacing, seed = 42) {
  const triCount = triVerts.length / 3;
  const cdf = new Float64Array(triCount);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const a = triVerts[t * 3] * 3, b = triVerts[t * 3 + 1] * 3, c = triVerts[t * 3 + 2] * 3;
    const ux = vertProperties[b] - vertProperties[a];
    const uy = vertProperties[b + 1] - vertProperties[a + 1];
    const uz = vertProperties[b + 2] - vertProperties[a + 2];
    const vx = vertProperties[c] - vertProperties[a];
    const vy = vertProperties[c + 1] - vertProperties[a + 1];
    const vz = vertProperties[c + 2] - vertProperties[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    total += Math.hypot(nx, ny, nz) / 2;
    cdf[t] = total;
  }
  if (total <= 0) return new Float32Array(0);

  const rng = mulberry32(seed);
  const minDist = spacing * 0.9;
  const minDist2 = minDist * minDist;
  // hex packing density ~1.155/s² — enough attempts to reach saturation
  const expected = Math.max(8, Math.ceil((total / (spacing * spacing)) * 1.2));
  const attempts = Math.min(60000, expected * 40);
  const grid = new PointGrid(minDist);
  const pts = [];

  for (let k = 0; k < attempts; k++) {
    // area-weighted triangle selection (binary search over the CDF)
    const r = rng() * total;
    let lo = 0, hi = triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1; else hi = mid;
    }
    const t = lo;
    const a = triVerts[t * 3] * 3, b = triVerts[t * 3 + 1] * 3, c = triVerts[t * 3 + 2] * 3;
    let r1 = rng(), r2 = rng();
    if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
    const w0 = 1 - r1 - r2;
    const x = w0 * vertProperties[a] + r1 * vertProperties[b] + r2 * vertProperties[c];
    const y = w0 * vertProperties[a + 1] + r1 * vertProperties[b + 1] + r2 * vertProperties[c + 1];
    const z = w0 * vertProperties[a + 2] + r1 * vertProperties[b + 2] + r2 * vertProperties[c + 2];

    // reject if the nearest accepted point is closer than minDist
    let ok = true;
    grid.forNeighbors(x, y, z, 1, (i) => {
      if (!ok) return;
      const dx = pts[i * 3] - x, dy = pts[i * 3 + 1] - y, dz = pts[i * 3 + 2] - z;
      if (dx * dx + dy * dy + dz * dz < minDist2) ok = false;
    });
    if (!ok) continue;
    grid.insert(pts.length / 3, x, y, z);
    pts.push(x, y, z);
  }
  return new Float32Array(pts);
}

/* ---------- Voronoi shell SDF ---------- */

/**
 * The Voronoi cell BOUNDARIES between seeds become the wall: sdf = strut/2 - (F2-F1)/2.
 * Cell interiors (regions close to a seed) are left open as holes.
 */
export function makeVoronoiShellSDF(seeds, spacing, strut) {
  const n = seeds.length / 3;
  const grid = new PointGrid(spacing);
  for (let i = 0; i < n; i++) {
    grid.insert(i, seeds[i * 3], seeds[i * 3 + 1], seeds[i * 3 + 2]);
  }
  const half = strut / 2;
  return (p) => {
    let d1 = Infinity, d2 = Infinity;
    grid.forNeighbors(p[0], p[1], p[2], 2, (i) => {
      const dx = seeds[i * 3] - p[0];
      const dy = seeds[i * 3 + 1] - p[1];
      const dz = seeds[i * 3 + 2] - p[2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < d1) { d2 = d1; d1 = d; }
      else if (d < d2) { d2 = d; }
    });
    if (d2 === Infinity) return -spacing; // far from any seed -> empty space
    return half - (d2 - d1) / 2;
  };
}

/* ---------- Delaunay wireframe ---------- */

/**
 * Approximate Delaunay adjacency: a pair (a,b) is a Voronoi neighbor (and
 * therefore a Delaunay edge) if the two nearest seeds to their midpoint are
 * again {a,b}.
 * @returns Uint32Array (2 * edge count)
 */
export function delaunayPairs(seeds, spacing) {
  const n = seeds.length / 3;
  const grid = new PointGrid(spacing);
  for (let i = 0; i < n; i++) {
    grid.insert(i, seeds[i * 3], seeds[i * 3 + 1], seeds[i * 3 + 2]);
  }
  const nearestTwo = (x, y, z) => {
    let i1 = -1, i2 = -1, d1 = Infinity, d2 = Infinity;
    grid.forNeighbors(x, y, z, 2, (i) => {
      const dx = seeds[i * 3] - x, dy = seeds[i * 3 + 1] - y, dz = seeds[i * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = i; }
      else if (d < d2) { d2 = d; i2 = i; }
    });
    return [i1, i2];
  };
  const maxD2 = (2.2 * spacing) ** 2;
  const pairs = [];
  for (let a = 0; a < n; a++) {
    const ax = seeds[a * 3], ay = seeds[a * 3 + 1], az = seeds[a * 3 + 2];
    grid.forNeighbors(ax, ay, az, 3, (b) => {
      if (b <= a) return;
      const dx = seeds[b * 3] - ax, dy = seeds[b * 3 + 1] - ay, dz = seeds[b * 3 + 2] - az;
      if (dx * dx + dy * dy + dz * dz > maxD2) return;
      const [i1, i2] = nearestTwo(ax + dx / 2, ay + dy / 2, az + dz / 2);
      if ((i1 === a && i2 === b) || (i1 === b && i2 === a)) pairs.push(a, b);
    });
  }
  return new Uint32Array(pairs);
}

/** Capsule SDF along edge segments: sdf = radius - distance(nearest segment). */
export function makeWireframeSDF(seeds, pairs, radius, spacing) {
  const cellSize = spacing;
  const map = new Map();
  const pad = radius + cellSize * 0.5;
  const segCount = pairs.length / 2;
  for (let s = 0; s < segCount; s++) {
    const a = pairs[s * 2] * 3, b = pairs[s * 2 + 1] * 3;
    const min = [0, 0, 0], max = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(seeds[a + k], seeds[b + k]) - pad;
      max[k] = Math.max(seeds[a + k], seeds[b + k]) + pad;
    }
    for (let ix = Math.floor(min[0] / cellSize); ix <= Math.floor(max[0] / cellSize); ix++) {
      for (let iy = Math.floor(min[1] / cellSize); iy <= Math.floor(max[1] / cellSize); iy++) {
        for (let iz = Math.floor(min[2] / cellSize); iz <= Math.floor(max[2] / cellSize); iz++) {
          const key = gridKey(ix, iy, iz);
          let arr = map.get(key);
          if (!arr) { arr = []; map.set(key, arr); }
          arr.push(s);
        }
      }
    }
  }
  return (p) => {
    const key = gridKey(
      Math.floor(p[0] / cellSize),
      Math.floor(p[1] / cellSize),
      Math.floor(p[2] / cellSize)
    );
    const arr = map.get(key);
    if (!arr) return -spacing;
    let best = Infinity;
    for (let k = 0; k < arr.length; k++) {
      const s = arr[k];
      const a = pairs[s * 2] * 3, b = pairs[s * 2 + 1] * 3;
      const ax = seeds[a], ay = seeds[a + 1], az = seeds[a + 2];
      const ux = seeds[b] - ax, uy = seeds[b + 1] - ay, uz = seeds[b + 2] - az;
      const wx = p[0] - ax, wy = p[1] - ay, wz = p[2] - az;
      const len2 = ux * ux + uy * uy + uz * uz;
      let t = len2 > 0 ? (wx * ux + wy * uy + wz * uz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const dx = wx - t * ux, dy = wy - t * uy, dz = wz - t * uz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    return radius - Math.sqrt(best);
  };
}

/* ---------- main pipeline ---------- */

export const SHELL_VARIANTS = {
  voronoiShell: { name: 'Voronoi shell' },
  delaunay: { name: 'Delaunay wireframe' }
};

/**
 * @param params { variant, holeSize, strut, thickness, edgeLength }
 * @param progress (key, arg?) => void
 */
export function applyShellCut(wasm, vertProperties, triVerts, params, progress = () => {}) {
  const { variant, holeSize, strut, thickness, edgeLength } = params;
  const def = SHELL_VARIANTS[variant];
  if (!def) throw codedError(`Unknown shell pattern: ${variant}`, 'unknown_pattern');

  const cleanup = [];
  const track = (m) => { cleanup.push(m); return m; };
  let warning = null;

  try {
    progress('preparing');
    let model;
    try {
      model = track(toManifold(wasm, vertProperties, triVerts));
    } catch {
      throw codedError(
        'Model is not manifold (may contain holes/flipped faces). ' +
        'Repair it with PrusaSlicer or an STL repair tool and try again.',
        'not_manifold'
      );
    }

    // Seed spacing: hole diameter + strut thickness ≈ distance between cell centers
    const spacing = holeSize + strut;

    progress('sampling');
    const seeds = sampleSurfacePoints(vertProperties, triVerts, spacing, 42);
    if (seeds.length / 3 < 4) {
      throw codedError(
        'Could not sample enough surface points — hole size is too large for this model.',
        'few_seeds'
      );
    }

    // Shell volume: model minus an inward-offset copy
    progress('boolean');
    const mMesh = getMeshOf(model);
    let shellSolid = null;
    try {
      const innerVerts = offsetVertsInward(mMesh.vertProperties, mMesh.triVerts, thickness);
      const inner = track(toManifold(wasm, innerVerts, mMesh.triVerts));
      if (volumeOf(inner) > 0) shellSolid = track(model.subtract(inner));
    } catch { /* handled below */ }
    if (!shellSolid || volumeOf(shellSolid) <= 0) {
      warning = 'no_shell';
      shellSolid = model; // thin/small model: the whole volume counts as shell
    }

    progress('generating', def.name);
    let sdf;
    if (variant === 'delaunay') {
      const pairs = delaunayPairs(seeds, spacing);
      if (pairs.length === 0) {
        throw codedError(
          'Could not sample enough surface points — hole size is too large for this model.',
          'few_seeds'
        );
      }
      sdf = makeWireframeSDF(seeds, pairs, strut / 2, spacing);
    } else {
      sdf = makeVoronoiShellSDF(seeds, spacing, strut);
    }

    // Bounding box + margin; sampling rule: grid edge <= half the strut thickness
    const { min, max } = boundsOf(vertProperties);
    const pad = strut;
    const box = {
      min: [min[0] - pad, min[1] - pad, min[2] - pad],
      max: [max[0] + pad, max[1] + pad, max[2] + pad]
    };
    const edgeLimited = Math.min(edgeLength, strut / 2);
    const cells =
      ((box.max[0] - box.min[0]) / edgeLimited) *
      ((box.max[1] - box.min[1]) / edgeLimited) *
      ((box.max[2] - box.min[2]) / edgeLimited);
    let edge = edgeLimited;
    if (cells > 40e6) {
      edge = edgeLimited * Math.cbrt(cells / 40e6);
      warning = warning || 'auto_res';
    }

    const patternSolid = track(wasm.Manifold.levelSet(sdf, box, edge, 0));
    const result = track(patternSolid.intersect(shellSolid));

    progress('extracting');
    const outMesh = getMeshOf(result);
    const out = {
      vertProperties: new Float32Array(outMesh.vertProperties),
      triVerts: new Uint32Array(outMesh.triVerts),
      volume: volumeOf(result),
      originalVolume: volumeOf(model),
      triangles: outMesh.triVerts.length / 3,
      seedCount: seeds.length / 3,
      warning
    };
    if (out.triangles === 0) {
      throw codedError(
        'Result was empty — check the parameters (hole size / strut thickness).',
        'empty_result'
      );
    }
    return out;
  } finally {
    for (const m of cleanup) {
      try { m.delete && m.delete(); } catch { /* ignore */ }
    }
  }
}
