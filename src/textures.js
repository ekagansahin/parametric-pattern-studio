// Surface texture engine: weld -> (densify) -> field evaluation -> displacement along the normal.
// Reaction-diffusion runs on the mesh's own adjacency graph (no UVs, seamless).
// Pure functions — used in the worker and in Node tests.
import { weldVertices } from './simplify.js';

/* ---------- helpers ---------- */

function hash01(ix, iy, iz, s) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^
          Math.imul(iz, 0x9e3779b9) ^ Math.imul(s, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Area-weighted, normalized vertex normals. */
export function computeVertexNormals(vp, tv) {
  const normals = new Float32Array(vp.length);
  for (let t = 0; t < tv.length; t += 3) {
    const ia = tv[t] * 3, ib = tv[t + 1] * 3, ic = tv[t + 2] * 3;
    const ux = vp[ib] - vp[ia], uy = vp[ib + 1] - vp[ia + 1], uz = vp[ib + 2] - vp[ia + 2];
    const vx = vp[ic] - vp[ia], vy = vp[ic + 1] - vp[ia + 1], vz = vp[ic + 2] - vp[ia + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [ia, ib, ic]) {
      normals[i] += nx; normals[i + 1] += ny; normals[i + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  return normals;
}

/** Average edge length (shared edges are counted twice — fine for an average). */
export function averageEdgeLength(vp, tv) {
  let sum = 0, count = 0;
  for (let t = 0; t < tv.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tv[t + e] * 3, b = tv[t + ((e + 1) % 3)] * 3;
      sum += Math.hypot(vp[a] - vp[b], vp[a + 1] - vp[b + 1], vp[a + 2] - vp[b + 2]);
      count++;
    }
  }
  return count ? sum / count : 0;
}

/** Midpoint subdivision: each triangle -> 4 triangles, shape unchanged, manifold preserved. */
export function subdivideOnce(vp, tv) {
  const oldVertCount = vp.length / 3;
  const triCount = tv.length / 3;
  const edgeMap = new Map();
  const newVerts = [];
  const midpoint = (a, b) => {
    const key = a < b ? a * 16777216 + b : b * 16777216 + a;
    let idx = edgeMap.get(key);
    if (idx === undefined) {
      idx = oldVertCount + newVerts.length / 3;
      edgeMap.set(key, idx);
      newVerts.push(
        (vp[a * 3] + vp[b * 3]) / 2,
        (vp[a * 3 + 1] + vp[b * 3 + 1]) / 2,
        (vp[a * 3 + 2] + vp[b * 3 + 2]) / 2
      );
    }
    return idx;
  };
  const outTris = new Uint32Array(triCount * 12);
  let o = 0;
  for (let t = 0; t < triCount; t++) {
    const a = tv[t * 3], b = tv[t * 3 + 1], c = tv[t * 3 + 2];
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    outTris.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], o);
    o += 12;
  }
  const outVerts = new Float32Array(vp.length + newVerts.length);
  outVerts.set(vp);
  outVerts.set(newVerts, vp.length);
  return { vertProperties: outVerts, triVerts: outTris };
}

/* ---------- procedural fields ---------- */

function valueNoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  let r = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const w = (dx ? sx : 1 - sx) * (dy ? sy : 1 - sy) * (dz ? sz : 1 - sz);
        r += w * hash01(ix + dx, iy + dy, iz + dz, 7);
      }
    }
  }
  return r;
}

function fbm(x, y, z) {
  let v = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < 4; o++) {
    v += amp * valueNoise(x * freq + o * 19.7, y * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return v / norm;
}

/** 2D wave field. */
function wave2D(u, v, s) {
  const k = (2 * Math.PI) / s;
  return 0.5 + 0.5 * Math.sin(u * k) * Math.sin(v * k);
}

/** 2D hexagon (honeycomb) field: walls rise along the cell boundaries. */
function hex2D(u, v, s) {
  const q = ((Math.sqrt(3) / 3) * u - (1 / 3) * v) / s;
  const r = ((2 / 3) * v) / s;
  // cube-coordinate rounding
  let rx = Math.round(q), ry = Math.round(-q - r), rz = Math.round(r);
  const dx = Math.abs(rx - q), dy = Math.abs(ry - (-q - r)), dz = Math.abs(rz - r);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dz > dy) rz = -rx - ry;
  const cx = s * Math.sqrt(3) * (rx + rz / 2);
  const cy = s * 1.5 * rz;
  const d = Math.hypot(u - cx, v - cy) / s; // 0 (center) -> ~1 (corner)
  const t = Math.min(Math.max((d - 0.62) / 0.2, 0), 1);
  return t * t * (3 - 2 * t);
}

/** Triplanar sampling: blended according to the normal's components. */
function triplanar(f2, px, py, pz, nx, ny, nz, s) {
  const wx = Math.abs(nx), wy = Math.abs(ny), wz = Math.abs(nz);
  const sum = wx + wy + wz || 1;
  return (f2(py, pz, s) * wx + f2(px, pz, s) * wy + f2(px, py, s) * wz) / sum;
}

/* ---------- reaction-diffusion (Gray-Scott, on the mesh graph) ---------- */

const RD_STYLES = {
  rd_spots: { F: 0.035, k: 0.065 },
  rd_maze: { F: 0.029, k: 0.057 },
  rd_coral: { F: 0.055, k: 0.062 }
};

function buildAdjacency(vertCount, tv) {
  const edgeSet = new Set();
  for (let t = 0; t < tv.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tv[t + e], b = tv[t + ((e + 1) % 3)];
      edgeSet.add(a < b ? a * 16777216 + b : b * 16777216 + a);
    }
  }
  const deg = new Uint32Array(vertCount);
  for (const key of edgeSet) {
    deg[Math.floor(key / 16777216)]++;
    deg[key % 16777216]++;
  }
  const off = new Uint32Array(vertCount + 1);
  for (let i = 0; i < vertCount; i++) off[i + 1] = off[i] + deg[i];
  const adj = new Uint32Array(off[vertCount]);
  const cursor = Uint32Array.from(off.subarray(0, vertCount));
  for (const key of edgeSet) {
    const a = Math.floor(key / 16777216), b = key % 16777216;
    adj[cursor[a]++] = b;
    adj[cursor[b]++] = a;
  }
  return { off, adj };
}

function grayScott(vp, tv, style, iters, progress) {
  const n = vp.length / 3;
  const { off, adj } = buildAdjacency(n, tv);
  const { F, k } = RD_STYLES[style] || RD_STYLES.rd_spots;
  const Du = 0.4, Dv = 0.2, dt = 1;

  let U = new Float32Array(n).fill(1);
  let V = new Float32Array(n);
  // Deterministic seeding: position-based; seed + its 1-ring of neighbors
  let seeds = 0;
  for (let i = 0; i < n; i++) {
    if (hash01(Math.round(vp[i * 3] * 2), Math.round(vp[i * 3 + 1] * 2),
               Math.round(vp[i * 3 + 2] * 2), 42) < 0.015) {
      V[i] = 1; U[i] = 0.5;
      for (let j = off[i]; j < off[i + 1]; j++) { V[adj[j]] = 1; U[adj[j]] = 0.5; }
      seeds++;
    }
  }
  if (seeds === 0) {
    for (let i = 0; i < n; i += 199) { V[i] = 1; U[i] = 0.5; }
  }

  let U2 = new Float32Array(n), V2 = new Float32Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      let su = 0, sv = 0;
      const s0 = off[i], s1 = off[i + 1];
      for (let j = s0; j < s1; j++) { const nb = adj[j]; su += U[nb]; sv += V[nb]; }
      const deg = (s1 - s0) || 1;
      const u = U[i], v = V[i];
      const uvv = u * v * v;
      U2[i] = u + (Du * (su / deg - u) - uvv + F * (1 - u)) * dt;
      V2[i] = v + (Dv * (sv / deg - v) + uvv - (F + k) * v) * dt;
    }
    [U, U2] = [U2, U];
    [V, V2] = [V2, V];
    if (it % 80 === 0) progress('rdsim');
  }
  return V;
}

/* ---------- main entry point ---------- */

export const TEXTURES = ['noise', 'wave', 'hex', 'rd_spots', 'rd_maze', 'rd_coral'];

/**
 * @param params { texture, scale, depth, subdiv: 'auto'|'off', rdIters? }
 */
export function applyTexture(vertProperties, triVerts, params, progress = () => {}) {
  const { texture, scale, depth, subdiv } = params;
  progress('preparing');
  let { vertProperties: vp, triVerts: tv } = weldVertices(vertProperties, triVerts);

  // Densify: reduce edge length enough to sample the texture scale
  if (subdiv !== 'off') {
    const target = scale / (texture.startsWith('rd_') ? 4 : 3);
    let avg = averageEdgeLength(vp, tv);
    while (avg > target && (tv.length / 3) * 4 <= 800000) {
      progress('subdividing');
      ({ vertProperties: vp, triVerts: tv } = subdivideOnce(vp, tv));
      avg /= 2;
    }
  }

  const normals = computeVertexNormals(vp, tv);
  const n = vp.length / 3;
  const field = new Float32Array(n);

  if (texture.startsWith('rd_')) {
    const rd = grayScott(vp, tv, texture, params.rdIters || 350, progress);
    field.set(rd);
  } else {
    progress('texturing');
    for (let i = 0; i < n; i++) {
      const px = vp[i * 3], py = vp[i * 3 + 1], pz = vp[i * 3 + 2];
      if (texture === 'noise') {
        field[i] = fbm(px / scale, py / scale, pz / scale);
      } else {
        const f2 = texture === 'wave' ? wave2D : hex2D;
        field[i] = triplanar(f2, px, py, pz,
          normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2], scale);
      }
    }
  }

  // Normalize: make the peak-to-valley difference exactly equal to "depth"
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++) {
    if (field[i] < mn) mn = field[i];
    if (field[i] > mx) mx = field[i];
  }
  let warning = null;
  if (mx - mn < 1e-6) {
    warning = 'rd_flat';
    field.fill(0.5);
  } else {
    for (let i = 0; i < n; i++) field[i] = (field[i] - mn) / (mx - mn);
  }

  const out = new Float32Array(vp.length);
  for (let i = 0; i < n; i++) {
    const d = depth * (field[i] - 0.5);
    out[i * 3] = vp[i * 3] + normals[i * 3] * d;
    out[i * 3 + 1] = vp[i * 3 + 1] + normals[i * 3 + 1] * d;
    out[i * 3 + 2] = vp[i * 3 + 2] + normals[i * 3 + 2] * d;
  }
  return { vertProperties: out, triVerts: tv, triangles: tv.length / 3, warning };
}
