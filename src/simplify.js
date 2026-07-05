// Low-poly / mesh simplification: based on meshoptimizer.
// Pure functions — used in the worker and in Node tests.

/** Merges duplicate vertices in the STL (bit-exact match). */
export function weldVertices(vertProperties, triVerts) {
  const map = new Map();
  const outVerts = [];
  const vertCount = vertProperties.length / 3;
  const remap = new Uint32Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    const x = vertProperties[i * 3], y = vertProperties[i * 3 + 1], z = vertProperties[i * 3 + 2];
    const key = `${x}_${y}_${z}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = outVerts.length / 3;
      map.set(key, idx);
      outVerts.push(x, y, z);
    }
    remap[i] = idx;
  }
  const outTris = new Uint32Array(triVerts.length);
  for (let i = 0; i < triVerts.length; i++) outTris[i] = remap[triVerts[i]];
  return { vertProperties: new Float32Array(outVerts), triVerts: outTris };
}

/** Drops unused vertices and compacts the indices. */
export function compactMesh(vertProperties, triVerts) {
  const used = new Int32Array(vertProperties.length / 3).fill(-1);
  const outVerts = [];
  const outTris = new Uint32Array(triVerts.length);
  for (let i = 0; i < triVerts.length; i++) {
    const v = triVerts[i];
    if (used[v] === -1) {
      used[v] = outVerts.length / 3;
      outVerts.push(vertProperties[v * 3], vertProperties[v * 3 + 1], vertProperties[v * 3 + 2]);
    }
    outTris[i] = used[v];
  }
  return { vertProperties: new Float32Array(outVerts), triVerts: outTris };
}

/* ---------- ratio <-> target triangle count sync (Step 7 cross-check) ---------- */

/** Ratio (%) -> target triangle count (at least 12). */
export function targetFromRatio(ratio, srcTriangles) {
  return Math.max(12, Math.round((srcTriangles * ratio) / 100));
}

/** Target triangle count -> ratio (%), clamped to [2, 90]. */
export function ratioFromTarget(target, srcTriangles) {
  if (!srcTriangles) return 2;
  return Math.min(90, Math.max(2, (target / srcTriangles) * 100));
}

/**
 * Reduces the triangle count to the target ratio.
 * @param simplifier MeshoptSimplifier (meshoptimizer)
 * @param ratio target triangle ratio, between 0-1
 */
export async function simplifyArrays(simplifier, vertProperties, triVerts, ratio) {
  await simplifier.ready;
  const welded = weldVertices(vertProperties, triVerts);
  const srcTriangles = welded.triVerts.length / 3;

  let targetIndexCount = Math.floor((welded.triVerts.length * ratio) / 3) * 3;
  targetIndexCount = Math.max(targetIndexCount, 36); // at least 12 triangles

  // error margin: wide so the ratio stays authoritative, capped to preserve quality
  const [indices] = simplifier.simplify(
    welded.triVerts, welded.vertProperties, 3, targetIndexCount, 0.1
  );

  const out = compactMesh(welded.vertProperties, indices);
  return {
    ...out,
    srcTriangles,
    triangles: out.triVerts.length / 3
  };
}
