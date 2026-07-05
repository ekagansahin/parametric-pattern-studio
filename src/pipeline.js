// Geometry pipeline: STL arrays -> manifold-3d -> patterned result.
// Pure functions — used in both the Web Worker and Node tests.
import { boundsOf } from './stl.js';

/** Pattern catalog. SDF: positive inside, approximate distance in mm. */
export const PATTERNS = {
  gyroid: {
    name: 'Gyroid',
    makeSDF(cell, wall) {
      const k = (2 * Math.PI) / cell;
      // 1.5: gyroid gradient calibration — empirically verified so the effective
      // wall thickness matches the requested mm value (see tests)
      const iso = (1.5 * wall * k) / 2;
      return (p) => {
        const x = p[0] * k, y = p[1] * k, z = p[2] * k;
        const g =
          Math.sin(x) * Math.cos(y) +
          Math.sin(y) * Math.cos(z) +
          Math.sin(z) * Math.cos(x);
        return (iso - Math.abs(g)) / k;
      };
    }
  },
  schwarzP: {
    name: 'Schwarz P',
    makeSDF(cell, wall) {
      const k = (2 * Math.PI) / cell;
      // 1.3: Schwarz P gradient calibration (effective wall ≈ requested mm)
      const iso = (1.3 * wall * k) / 2;
      return (p) => {
        const g = Math.cos(p[0] * k) + Math.cos(p[1] * k) + Math.cos(p[2] * k);
        return (iso - Math.abs(g)) / k;
      };
    }
  },
  voronoi: {
    name: 'Voronoi foam',
    makeSDF(cell, wall) {
      // Jittered-grid Worley noise (F2-F1): a deterministic pseudo-random seed
      // per cell; the wall is the boundary region between the two nearest seeds.
      const half = wall / 2;
      return (p) => {
        const px = p[0] / cell, py = p[1] / cell, pz = p[2] / cell;
        const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
        let d1 = Infinity, d2 = Infinity;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              const ix = cx + dx, iy = cy + dy, iz = cz + dz;
              const sx = ix + hash01(ix, iy, iz, 1);
              const sy = iy + hash01(ix, iy, iz, 2);
              const sz = iz + hash01(ix, iy, iz, 3);
              const ddx = px - sx, ddy = py - sy, ddz = pz - sz;
              const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) * cell;
              if (d < d1) { d2 = d1; d1 = d; }
              else if (d < d2) { d2 = d; }
            }
          }
        }
        // approximate distance to the cell boundary: (F2-F1)/2
        return half - (d2 - d1) / 2;
      };
    }
  }
};

/** Deterministic 3D integer hash -> [0,1) */
function hash01(ix, iy, iz, s) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^
          Math.imul(iz, 0x9e3779b9) ^ Math.imul(s, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/* ---------- manifold-3d compatibility helpers ---------- */

export function toManifold(wasm, vertProperties, triVerts) {
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties, triVerts });
  mesh.merge(); // merges duplicate vertices from the STL
  return new wasm.Manifold(mesh);
}

export function getMeshOf(manifold) {
  return manifold.getMesh ? manifold.getMesh() : manifold.getMeshGL();
}

export function volumeOf(manifold) {
  if (typeof manifold.volume === 'function') return manifold.volume();
  if (typeof manifold.getProperties === 'function') return manifold.getProperties().volume;
  return 0;
}

/** Tests whether the mesh is manifold (print-ready topology). */
export function isMeshManifold(wasm, vertProperties, triVerts) {
  try {
    const m = toManifold(wasm, vertProperties, triVerts);
    m.delete();
    return true;
  } catch {
    return false;
  }
}

/* ---------- inward offset for the shell ---------- */

/** Moves vertices inward along the (area-weighted) normal direction. */
export function offsetVertsInward(vertProperties, triVerts, dist) {
  const normals = new Float32Array(vertProperties.length);
  for (let t = 0; t < triVerts.length; t += 3) {
    const ia = triVerts[t] * 3, ib = triVerts[t + 1] * 3, ic = triVerts[t + 2] * 3;
    const ux = vertProperties[ib] - vertProperties[ia];
    const uy = vertProperties[ib + 1] - vertProperties[ia + 1];
    const uz = vertProperties[ib + 2] - vertProperties[ia + 2];
    const vx = vertProperties[ic] - vertProperties[ia];
    const vy = vertProperties[ic + 1] - vertProperties[ia + 1];
    const vz = vertProperties[ic + 2] - vertProperties[ia + 2];
    // area-weighted surface normal (unnormalized cross product)
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [ia, ib, ic]) {
      normals[i] += nx; normals[i + 1] += ny; normals[i + 2] += nz;
    }
  }
  const out = new Float32Array(vertProperties.length);
  for (let i = 0; i < vertProperties.length; i += 3) {
    const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    out[i] = vertProperties[i] - (nx / len) * dist;
    out[i + 1] = vertProperties[i + 1] - (ny / len) * dist;
    out[i + 2] = vertProperties[i + 2] - (nz / len) * dist;
  }
  return out;
}

/* ---------- main pipeline ---------- */

/**
 * @param params { pattern, cell, wall, shell, edgeLength }
 * @param progress (msg: string) => void
 */
function codedError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function applyPattern(wasm, vertProperties, triVerts, params, progress = () => {}) {
  const { pattern, cell, wall, shell, edgeLength } = params;
  const def = PATTERNS[pattern];
  if (!def) throw codedError(`Unknown pattern: ${pattern}`, 'unknown_pattern');

  const cleanup = [];
  const track = (m) => { cleanup.push(m); return m; };
  let warning = null;

  try {
    progress('preparing');
    let model;
    try {
      model = track(toManifold(wasm, vertProperties, triVerts));
    } catch (e) {
      throw codedError(
        'Model is not manifold (may contain holes/flipped faces). ' +
        'Repair it with PrusaSlicer or an STL repair tool and try again.',
        'not_manifold'
      );
    }

    // Bounding box + small margin
    const { min, max } = boundsOf(vertProperties);
    const pad = edgeLength * 2;
    const box = {
      min: [min[0] - pad, min[1] - pad, min[2] - pad],
      max: [max[0] + pad, max[1] + pad, max[2] + pad]
    };

    // Sampling rule: the grid edge must be at most half the wall thickness,
    // otherwise walls get under-sampled (verified by tests).
    const edgeLimited = Math.min(edgeLength, wall / 2);

    // Grid safety: prevent runaway computations
    const cells =
      ((box.max[0] - box.min[0]) / edgeLimited) *
      ((box.max[1] - box.min[1]) / edgeLimited) *
      ((box.max[2] - box.min[2]) / edgeLimited);
    let edge = edgeLimited;
    if (cells > 40e6) {
      edge = edgeLimited * Math.cbrt(cells / 40e6);
      warning = 'auto_res';
    }

    progress('generating', def.name);
    const sdf = def.makeSDF(cell, wall);
    const patternSolid = track(wasm.Manifold.levelSet(sdf, box, edge, 0));

    progress('boolean');
    let result;
    if (shell > 0) {
      const mMesh = getMeshOf(model);
      let inner = null;
      try {
        const innerVerts = offsetVertsInward(
          mMesh.vertProperties, mMesh.triVerts, shell
        );
        inner = track(toManifold(wasm, innerVerts, mMesh.triVerts));
        if (volumeOf(inner) <= 0) { inner = null; }
      } catch (e) {
        inner = null;
      }
      if (inner) {
        const shellSolid = track(model.subtract(inner));
        const infill = track(patternSolid.intersect(inner));
        result = track(shellSolid.add(infill));
      } else {
        warning = 'no_shell';
        result = track(patternSolid.intersect(model));
      }
    } else {
      result = track(patternSolid.intersect(model));
    }

    progress('extracting');
    const outMesh = getMeshOf(result);
    const out = {
      vertProperties: new Float32Array(outMesh.vertProperties),
      triVerts: new Uint32Array(outMesh.triVerts),
      volume: volumeOf(result),
      originalVolume: volumeOf(model),
      triangles: outMesh.triVerts.length / 3,
      warning
    };
    if (out.triangles === 0) {
      throw codedError(
        'Result was empty — check the parameters (cell size / wall thickness).',
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
