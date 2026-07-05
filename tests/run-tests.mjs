// Node-based geometry tests: npm test
// Validates the pipeline end-to-end (parse → manifold → gyroid → boolean → export).
import Module from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { applyPattern, PATTERNS, isMeshManifold } from '../src/pipeline.js';
import { weldVertices, simplifyArrays } from '../src/simplify.js';
import { parseSTL, exportSTL, signedVolume } from '../src/stl.js';
import { STRINGS } from '../src/i18n.js';
import {
  applyTexture, subdivideOnce, averageEdgeLength, computeVertexNormals, TEXTURES
} from '../src/textures.js';
import {
  sampleSurfacePoints, delaunayPairs, applyShellCut, SHELL_VARIANTS
} from '../src/shellcut.js';
import { targetFromRatio, ratioFromTarget } from '../src/simplify.js';
import { clipConstant } from '../src/clip.js';
import {
  totalBytes, pruneSelection, isSameModel, formatSize, MAX_LIBRARY_BYTES
} from '../src/library.js';
import { readFileSync } from 'fs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${detail}`); }
}

// Section filter: TEST_SECTIONS=core|textures|shell|step7|library (comma-separated; empty = all)
const SECTIONS = new Set(
  (process.env.TEST_SECTIONS || 'core,textures,shell,step7,library').split(',')
);

const wasm = await Module();
wasm.setup();

// Test model: 40mm cube (manifold-3d's own cube — guaranteed manifold)
const cube = wasm.Manifold.cube([40, 40, 40], true);
const cubeMesh = cube.getMesh ? cube.getMesh() : cube.getMeshGL();
const cubeVerts = new Float32Array(cubeMesh.vertProperties);
const cubeTris = new Uint32Array(cubeMesh.triVerts);
const cubeVolume = 40 * 40 * 40;

// Non-manifold sample input (used across several sections)
const badVerts = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]); // a single open triangle
const badTris = new Uint32Array([0, 1, 2]);

if (SECTIONS.has('core')) {
console.log('\n[1] Gyroid infill — no shell (shell=0)');
const r1 = applyPattern(wasm, cubeVerts, cubeTris, {
  pattern: 'gyroid', cell: 10, wall: 1.2, shell: 0, edgeLength: 10 / 8
});
check('result has triangles', r1.triangles > 0, `(${r1.triangles})`);
check('volume > 0', r1.volume > 0, `(${r1.volume.toFixed(0)})`);
check('volume smaller than cube', r1.volume < cubeVolume, `(${r1.volume.toFixed(0)} / ${cubeVolume})`);
check('fill within a reasonable range (10-60%)',
  r1.volume / cubeVolume > 0.10 && r1.volume / cubeVolume < 0.60,
  `(%${(100 * r1.volume / cubeVolume).toFixed(1)})`);
// Effective wall thickness: fill × cell / gyroid surface density (≈3.09)
const effWall = (r1.volume / cubeVolume) * 10 / 3.09;
check('effective wall thickness close to requested (1.2mm ±15%)',
  Math.abs(effWall - 1.2) / 1.2 < 0.15, `(${effWall.toFixed(2)}mm)`);

console.log('\n[2] Gyroid infill — with shell (shell=2)');
const r2 = applyPattern(wasm, cubeVerts, cubeTris, {
  pattern: 'gyroid', cell: 10, wall: 1.2, shell: 2, edgeLength: 10 / 8
});
check('completed without warning (shell was created)', r2.warning === null, `(${r2.warning})`);
check('shelled volume > shell-less volume', r2.volume > r1.volume,
  `(${r2.volume.toFixed(0)} vs ${r1.volume.toFixed(0)})`);
check('volume smaller than cube', r2.volume < cubeVolume);

console.log('\n[3] Is the output manifold?');
for (const [label, r] of [['no-shell', r1], ['shelled', r2]]) {
  let ok = true, genusInfo = '';
  try {
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: r.vertProperties, triVerts: r.triVerts });
    mesh.merge();
    const m = new wasm.Manifold(mesh);
    genusInfo = `genus=${m.genus ? m.genus() : '?'}`;
    m.delete();
  } catch (e) { ok = false; genusInfo = String(e.message || e); }
  check(`${label} output can be rebuilt as manifold`, ok, genusInfo);
}

console.log('\n[4] STL export → import round trip');
const buf = exportSTL(r2.vertProperties, r2.triVerts);
check('binary STL size is correct', buf.byteLength === 84 + r2.triangles * 50);
const back = parseSTL(buf);
check('triangle count preserved', back.triVerts.length / 3 === r2.triangles);
const volBack = Math.abs(signedVolume(back.vertProperties, back.triVerts));
check('volume preserved (±1%)', Math.abs(volBack - r2.volume) / r2.volume < 0.01,
  `(${volBack.toFixed(0)} vs ${r2.volume.toFixed(0)})`);

console.log('\n[5] Bad input: a non-manifold mesh should raise a clear error');
let threw = false, msg = '';
try {
  applyPattern(wasm, badVerts, badTris, { pattern: 'gyroid', cell: 10, wall: 1.2, shell: 0, edgeLength: 1 });
} catch (e) { threw = true; msg = e.message; }
check('error was thrown', threw);
check('error message is in English and actionable', /not manifold/i.test(msg), `(${msg})`);
let errCode = null;
try {
  applyPattern(wasm, badVerts, badTris, { pattern: 'gyroid', cell: 10, wall: 1.2, shell: 0, edgeLength: 1 });
} catch (e) { errCode = e.code; }
check("error code is 'not_manifold' (for i18n)", errCode === 'not_manifold', `(${errCode})`);
let upCode = null;
try {
  applyPattern(wasm, cubeVerts, cubeTris, { pattern: 'none', cell: 10, wall: 1.2, shell: 0, edgeLength: 1 });
} catch (e) { upCode = e.code; }
check("unknown pattern code is 'unknown_pattern'", upCode === 'unknown_pattern', `(${upCode})`);

console.log('\n[6] Pattern catalog SDF check');
const sdf = PATTERNS.gyroid.makeSDF(10, 1.2);
check('gyroid wall center is inside (sdf>0)', sdf([0, 0, 0]) > 0);
check('outside the wall is empty (sdf<0)', sdf([2.5, 0, 0]) < 0, `(${sdf([2.5, 0, 0]).toFixed(3)})`);

console.log('\n[7] All patterns: end-to-end (cube, shell=0)');
const AREA_DENSITY = { gyroid: 3.09, schwarzP: 2.34 }; // unit-cell surface density
for (const key of Object.keys(PATTERNS)) {
  const r = applyPattern(wasm, cubeVerts, cubeTris, {
    pattern: key, cell: 10, wall: 1.2, shell: 0, edgeLength: 10 / 8
  });
  const fill = r.volume / cubeVolume;
  check(`${key}: produced triangles`, r.triangles > 0, `(${r.triangles})`);
  check(`${key}: reasonable fill (5-60%)`, fill > 0.05 && fill < 0.60,
    `(%${(100 * fill).toFixed(1)})`);
  let manifoldOK = true;
  try {
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: r.vertProperties, triVerts: r.triVerts });
    mesh.merge();
    new wasm.Manifold(mesh).delete();
  } catch { manifoldOK = false; }
  check(`${key}: output is manifold`, manifoldOK);
  if (AREA_DENSITY[key]) {
    const eff = fill * 10 / AREA_DENSITY[key];
    check(`${key}: effective wall 1.2mm ±15%`, Math.abs(eff - 1.2) / 1.2 < 0.15,
      `(${eff.toFixed(2)}mm)`);
  }
}

console.log('\n[8] Voronoi determinism (same input → same output)');
const v1 = applyPattern(wasm, cubeVerts, cubeTris,
  { pattern: 'voronoi', cell: 12, wall: 1.6, shell: 0, edgeLength: 1 });
const v2 = applyPattern(wasm, cubeVerts, cubeTris,
  { pattern: 'voronoi', cell: 12, wall: 1.6, shell: 0, edgeLength: 1 });
check('volumes are exactly equal', v1.volume === v2.volume,
  `(${v1.volume.toFixed(2)} vs ${v2.volume.toFixed(2)})`);
check('thicker wall increases volume (monotonic)', (() => {
  const thick = applyPattern(wasm, cubeVerts, cubeTris,
    { pattern: 'voronoi', cell: 12, wall: 2.4, shell: 0, edgeLength: 1 });
  return thick.volume > v1.volume;
})());

console.log('\n[9] Low-poly: source (weld)');
// STL-style duplicated-vertex cube: 12 triangles × 3 = 36 verts → 8 unique
const stlStyle = (() => {
  const vp = new Float32Array(cubeTris.length * 3);
  const tv = new Uint32Array(cubeTris.length);
  for (let i = 0; i < cubeTris.length; i++) {
    const v = cubeTris[i] * 3;
    vp[i * 3] = cubeVerts[v]; vp[i * 3 + 1] = cubeVerts[v + 1]; vp[i * 3 + 2] = cubeVerts[v + 2];
    tv[i] = i;
  }
  return { vertProperties: vp, triVerts: tv };
})();
const welded = weldVertices(stlStyle.vertProperties, stlStyle.triVerts);
check('36 duplicate vertices → 8 unique vertices', welded.vertProperties.length / 3 === 8,
  `(${welded.vertProperties.length / 3})`);
check('triangle count preserved', welded.triVerts.length === stlStyle.triVerts.length);

console.log('\n[10] Low-poly: simplification (dense sphere, target 20%)');
const sphere = wasm.Manifold.sphere(20, 96);
const sMesh = sphere.getMesh ? sphere.getMesh() : sphere.getMeshGL();
const sVerts = new Float32Array(sMesh.vertProperties);
const sTris = new Uint32Array(sMesh.triVerts);
const sVol = Math.abs(signedVolume(sVerts, sTris));
const lp = await simplifyArrays(MeshoptSimplifier, sVerts, sTris, 0.2);
check('triangle count hit the target (±30% tolerance)',
  lp.triangles <= lp.srcTriangles * 0.2 * 1.3 && lp.triangles >= 12,
  `(${lp.srcTriangles} → ${lp.triangles})`);
const lpVol = Math.abs(signedVolume(lp.vertProperties, lp.triVerts));
check('volume preserved (±5%)', Math.abs(lpVol - sVol) / sVol < 0.05,
  `(${(100 * Math.abs(lpVol - sVol) / sVol).toFixed(2)}% deviation)`);
check('output is manifold', isMeshManifold(wasm, lp.vertProperties, lp.triVerts));
const lp2 = await simplifyArrays(MeshoptSimplifier, sVerts, sTris, 0.05);
check('lower ratio → fewer triangles', lp2.triangles < lp.triangles,
  `(${lp2.triangles} < ${lp.triangles})`);

console.log('\n[11] Low-poly: STL round trip + chaining (simplify → apply pattern)');
const lpBuf = exportSTL(lp.vertProperties, lp.triVerts);
const lpBack = parseSTL(lpBuf);
check('STL round trip preserves triangles', lpBack.triVerts.length / 3 === lp.triangles);
const chained = applyPattern(wasm, lp.vertProperties, lp.triVerts, {
  pattern: 'gyroid', cell: 8, wall: 1.2, shell: 1.6, edgeLength: 1
});
check('a pattern can be applied to the simplified model', chained.triangles > 0,
  `(${chained.triangles} triangles)`);
check('chained result volume is reasonable', chained.volume > 0 && chained.volume < sVol);

console.log('\n[12] i18n: TR/EN dictionary parity');
function keyTree(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') keys.push(...keyTree(v, `${prefix}${k}.`));
    else keys.push(`${prefix}${k}:${typeof v}`);
  }
  return keys.sort();
}
const trKeys = keyTree(STRINGS.tr), enKeys = keyTree(STRINGS.en);
const missing = trKeys.filter((k) => !enKeys.includes(k))
  .concat(enKeys.filter((k) => !trKeys.includes(k)));
check('TR and EN dictionaries have identical key/type structure', missing.length === 0,
  `(missing: ${missing.slice(0, 5).join(', ')})`);

console.log('\n[13] Progress keys exist in the dictionary');
const seen = [];
applyPattern(wasm, cubeVerts, cubeTris,
  { pattern: 'gyroid', cell: 10, wall: 1.2, shell: 2, edgeLength: 1.25 },
  (key) => seen.push(key));
check('expected sequence emitted',
  JSON.stringify(seen) === JSON.stringify(['preparing', 'generating', 'boolean', 'extracting']),
  `(${seen.join(' → ')})`);
check('all keys exist in both languages',
  seen.every((k) => STRINGS.tr.progress[k] && STRINGS.en.progress[k]));

console.log('\n[14] Warning codes: no_shell when a shell is impossible');
const w = applyPattern(wasm, cubeVerts, cubeTris,
  { pattern: 'gyroid', cell: 10, wall: 1.2, shell: 30, edgeLength: 1.25 });
check("warning code is 'no_shell'", w.warning === 'no_shell', `(${w.warning})`);
check('warning code is translated in both languages',
  Boolean(STRINGS.tr.warn.no_shell && STRINGS.en.warn.no_shell));
check('shell-less result was still produced', w.triangles > 0);

console.log('\n[15] STL error codes');
let smallCode = null;
try { parseSTL(new ArrayBuffer(4)); } catch (e) { smallCode = e.code; }
check("tiny file → 'file_small'", smallCode === 'file_small', `(${smallCode})`);
check('code is translated in the dictionary', Boolean(STRINGS.tr.errors.file_small && STRINGS.en.errors.file_small));

console.log('\n[16] isMeshManifold badge function');
check('cube → OK', isMeshManifold(wasm, cubeVerts, cubeTris) === true);
check('open triangle → not OK', isMeshManifold(wasm, badVerts, badTris) === false);
}

if (SECTIONS.has('textures')) {
console.log('\n[17] Subdivision (midpoint)');
const sub1 = subdivideOnce(cubeVerts, cubeTris);
check('triangle count quadrupled', sub1.triVerts.length === cubeTris.length * 4);
check('edge midpoints are shared (V = 8+18 = 26)',
  sub1.vertProperties.length / 3 === 26, `(${sub1.vertProperties.length / 3})`);
check('subdivision preserves manifold', isMeshManifold(wasm, sub1.vertProperties, sub1.triVerts));
check('average edge length halved (±1%)',
  Math.abs(averageEdgeLength(sub1.vertProperties, sub1.triVerts) /
           averageEdgeLength(cubeVerts, cubeTris) - 0.5) < 0.01);
const nrm = computeVertexNormals(cubeVerts, cubeTris);
check('normals are unit length', Math.abs(Math.hypot(nrm[0], nrm[1], nrm[2]) - 1) < 1e-5);

console.log('\n[18] Texture: noise displacement properties');
const tex1 = applyTexture(cubeVerts, cubeTris,
  { texture: 'noise', scale: 8, depth: 1.5, subdiv: 'auto' });
check('densification ran (triangle count increased)', tex1.triangles > cubeTris.length / 3,
  `(${cubeTris.length / 3} → ${tex1.triangles})`);
check('output is manifold', isMeshManifold(wasm, tex1.vertProperties, tex1.triVerts));
const tex1b = applyTexture(cubeVerts, cubeTris,
  { texture: 'noise', scale: 8, depth: 1.5, subdiv: 'auto' });
check('deterministic (two runs are identical)',
  tex1.vertProperties.every((v, i) => v === tex1b.vertProperties[i]));
// Bounding box can grow by at most depth/2
const bIn = (() => { let m = 0; for (const v of cubeVerts) m = Math.max(m, Math.abs(v)); return m; })();
const bOut = (() => { let m = 0; for (const v of tex1.vertProperties) m = Math.max(m, Math.abs(v)); return m; })();
check('displacement is bounded (≤ depth/2)', bOut - bIn <= 0.75 + 1e-4,
  `(${(bOut - bIn).toFixed(3)}mm)`);

console.log('\n[19] Texture: all types produce output');
for (const t of TEXTURES) {
  const r = applyTexture(cubeVerts, cubeTris,
    { texture: t, scale: 10, depth: 1, subdiv: 'auto', rdIters: 120 });
  const finite = r.vertProperties.every(Number.isFinite);
  check(`${t}: finite output with triangles`, finite && r.triangles > 0,
    `(${r.triangles} triangles, warning: ${r.warning})`);
}

console.log('\n[20] Reaction-diffusion: pattern emerges and is deterministic');
const sphereMesh = (() => {
  const s = wasm.Manifold.sphere(20, 48);
  const m = s.getMesh ? s.getMesh() : s.getMeshGL();
  return { vp: new Float32Array(m.vertProperties), tv: new Uint32Array(m.triVerts) };
})();
const rd1 = applyTexture(sphereMesh.vp, sphereMesh.tv,
  { texture: 'rd_spots', scale: 8, depth: 1, subdiv: 'auto', rdIters: 200 });
check('pattern emerged (no warning)', rd1.warning === null, `(${rd1.warning})`);
// displacement spread: a non-constant field should scatter vertex offsets
const disp = [];
{
  const welded = subdivideOnce(sphereMesh.vp, sphereMesh.tv); // size reference only
  for (let i = 0; i < rd1.vertProperties.length; i += 3) {
    disp.push(Math.hypot(rd1.vertProperties[i], rd1.vertProperties[i + 1], rd1.vertProperties[i + 2]) - 20);
  }
}
const mean = disp.reduce((a, b) => a + b, 0) / disp.length;
const std = Math.sqrt(disp.reduce((a, b) => a + (b - mean) ** 2, 0) / disp.length);
check('pattern has contrast (std > 0.05mm)', std > 0.05, `(std=${std.toFixed(3)})`);
const rd2 = applyTexture(sphereMesh.vp, sphereMesh.tv,
  { texture: 'rd_spots', scale: 8, depth: 1, subdiv: 'auto', rdIters: 200 });
check('deterministic', rd1.vertProperties.every((v, i) => v === rd2.vertProperties[i]));
check('output is manifold', isMeshManifold(wasm, rd1.vertProperties, rd1.triVerts));

console.log('\n[21] Chaining: texture → gyroid infill');
const chained2 = applyPattern(wasm, tex1.vertProperties, tex1.triVerts,
  { pattern: 'gyroid', cell: 10, wall: 1.2, shell: 1.6, edgeLength: 1.25 });
check('a pattern can be applied to a textured model', chained2.triangles > 0,
  `(${chained2.triangles} triangles)`);
}

if (SECTIONS.has('shell')) {
console.log('\n[22] Shell perforation: surface point sampling');
const seeds = sampleSurfacePoints(cubeVerts, cubeTris, 10, 42);
const seedCount = seeds.length / 3;
check('enough seeds were produced (>20)', seedCount > 20, `(${seedCount})`);
{
  let onSurface = true;
  for (let i = 0; i < seedCount; i++) {
    const x = seeds[i * 3], y = seeds[i * 3 + 1], z = seeds[i * 3 + 2];
    // 40mm cube (±20): every point must lie on a face → at least one coordinate ±20
    const onFace = Math.abs(Math.abs(x) - 20) < 1e-4 || Math.abs(Math.abs(y) - 20) < 1e-4 ||
                   Math.abs(Math.abs(z) - 20) < 1e-4;
    const inBounds = Math.abs(x) <= 20.0001 && Math.abs(y) <= 20.0001 && Math.abs(z) <= 20.0001;
    if (!onFace || !inBounds) { onSurface = false; break; }
  }
  check('all seeds are on the surface', onSurface);
  let minD = Infinity;
  for (let i = 0; i < seedCount; i++) {
    for (let j = i + 1; j < seedCount; j++) {
      const dx = seeds[i * 3] - seeds[j * 3];
      const dy = seeds[i * 3 + 1] - seeds[j * 3 + 1];
      const dz = seeds[i * 3 + 2] - seeds[j * 3 + 2];
      minD = Math.min(minD, Math.hypot(dx, dy, dz));
    }
  }
  check('minimum distance between seeds is preserved (≥ 0.9×spacing)', minD >= 9 - 1e-6,
    `(${minD.toFixed(2)}mm)`);
}
const seedsB = sampleSurfacePoints(cubeVerts, cubeTris, 10, 42);
check('sampling is deterministic', seeds.length === seedsB.length &&
  seeds.every((v, i) => v === seedsB[i]));

console.log('\n[23] Shell perforation: Delaunay adjacency pairs');
const pairs = delaunayPairs(seeds, 10);
check('edges were produced', pairs.length >= 2, `(${pairs.length / 2} edges)`);
{
  const deg = new Uint32Array(seedCount);
  for (const i of pairs) deg[i]++;
  let isolated = 0;
  for (const d of deg) if (d === 0) isolated++;
  check('the large majority of seeds are connected (<10% isolated)',
    isolated / seedCount < 0.10, `(${isolated}/${seedCount} isolated)`);
}

console.log('\n[24] Shell perforation: Voronoi shell end-to-end (cube)');
const shellParams = { variant: 'voronoiShell', holeSize: 8, strut: 2, thickness: 2, edgeLength: 1 };
const sc1 = applyShellCut(wasm, cubeVerts, cubeTris, shellParams);
check('produced triangles', sc1.triangles > 0, `(${sc1.triangles})`);
check('no warning (shell was created)', sc1.warning === null, `(${sc1.warning})`);
// full shell volume: 40³ − 36³ = 17344; holes should reduce this noticeably
const fullShellVol = 40 ** 3 - 36 ** 3;
check('volume > 0', sc1.volume > 0, `(${sc1.volume.toFixed(0)})`);
check('holes were opened (volume < 85% of shell volume)', sc1.volume < fullShellVol * 0.85,
  `(${sc1.volume.toFixed(0)} / ${fullShellVol})`);
check('struts remain (volume > 10% of shell volume)', sc1.volume > fullShellVol * 0.10,
  `(%${(100 * sc1.volume / fullShellVol).toFixed(1)})`);
check('output is manifold', isMeshManifold(wasm, sc1.vertProperties, sc1.triVerts));
{
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: sc1.vertProperties, triVerts: sc1.triVerts });
  mesh.merge();
  const m = new wasm.Manifold(mesh);
  const genus = m.genus ? m.genus() : 1;
  m.delete();
  check('topological holes exist (genus > 0)', genus > 0, `(genus=${genus})`);
}
const sc1b = applyShellCut(wasm, cubeVerts, cubeTris, shellParams);
check('deterministic (identical volume)', sc1.volume === sc1b.volume);
// thicker struts should increase volume
const scThick = applyShellCut(wasm, cubeVerts, cubeTris, { ...shellParams, strut: 3.5 });
check('thicker strut → more volume', scThick.volume > sc1.volume,
  `(${scThick.volume.toFixed(0)} > ${sc1.volume.toFixed(0)})`);

console.log('\n[25] Shell perforation: Delaunay wireframe end-to-end (cube)');
const sc2 = applyShellCut(wasm, cubeVerts, cubeTris,
  { variant: 'delaunay', holeSize: 8, strut: 2.5, thickness: 2.5, edgeLength: 1 });
check('produced triangles', sc2.triangles > 0, `(${sc2.triangles})`);
check("reasonable volume (3-85% of the shell)",
  sc2.volume > fullShellVol * 0.03 && sc2.volume < fullShellVol * 0.85,
  `(%${(100 * sc2.volume / fullShellVol).toFixed(1)})`);
check('output is manifold', isMeshManifold(wasm, sc2.vertProperties, sc2.triVerts));

console.log('\n[26] Shell perforation: error/warning paths + i18n');
let fsCode = null;
try {
  applyShellCut(wasm, cubeVerts, cubeTris,
    { variant: 'voronoiShell', holeSize: 500, strut: 2, thickness: 2, edgeLength: 1 });
} catch (e) { fsCode = e.code; }
check("huge hole size → 'few_seeds'", fsCode === 'few_seeds', `(${fsCode})`);
check('few_seeds is translated in both languages',
  Boolean(STRINGS.tr.errors.few_seeds && STRINGS.en.errors.few_seeds));
let badShellCode = null;
try {
  applyShellCut(wasm, badVerts, badTris,
    { variant: 'voronoiShell', holeSize: 8, strut: 2, thickness: 2, edgeLength: 1 });
} catch (e) { badShellCode = e.code; }
check("non-manifold input → 'not_manifold'", badShellCode === 'not_manifold', `(${badShellCode})`);
const scNoShell = applyShellCut(wasm, cubeVerts, cubeTris,
  { variant: 'voronoiShell', holeSize: 8, strut: 2, thickness: 30, edgeLength: 1 });
check("impossible shell → 'no_shell' warning + a result", scNoShell.warning === 'no_shell' &&
  scNoShell.triangles > 0, `(${scNoShell.warning}, ${scNoShell.triangles})`);
const shellProgress = [];
applyShellCut(wasm, cubeVerts, cubeTris, shellParams, (key) => shellProgress.push(key));
check('progress sequence is correct', JSON.stringify(shellProgress) ===
  JSON.stringify(['preparing', 'sampling', 'boolean', 'generating', 'extracting']),
  `(${shellProgress.join(' → ')})`);
check('progress keys exist in both languages',
  shellProgress.every((k) => STRINGS.tr.progress[k] && STRINGS.en.progress[k]));
check('variant catalog contains 2 patterns', Object.keys(SHELL_VARIANTS).length === 2);

console.log('\n[27] Shell perforation: STL round trip');
const scBuf = exportSTL(sc1.vertProperties, sc1.triVerts);
const scBack = parseSTL(scBuf);
check('STL round trip preserves triangles', scBack.triVerts.length / 3 === sc1.triangles);
check('the re-read mesh is manifold', isMeshManifold(wasm, scBack.vertProperties, scBack.triVerts));
}

if (SECTIONS.has('step7')) {
console.log('\n[28] Step 7: ratio <-> target triangle count sync');
check('ratio → target (25% × 10000 = 2500)', targetFromRatio(25, 10000) === 2500);
check('target → ratio (2500 / 10000 = 25%)', ratioFromTarget(2500, 10000) === 25);
check('round trip is stable', (() => {
  const tri = 34567;
  for (const r of [2, 10, 25, 50, 90]) {
    const t = targetFromRatio(r, tri);
    if (Math.round(ratioFromTarget(t, tri)) !== r) return false;
  }
  return true;
})());
check('ratio lower bound is 2 (very small target)', ratioFromTarget(1, 10000) === 2);
check('ratio upper bound is 90 (target > source)', ratioFromTarget(99999, 10000) === 90);
check('target is at least 12 triangles', targetFromRatio(2, 100) === 12);
check('ratio is 2 when there is no model', ratioFromTarget(500, 0) === 2);

console.log('\n[29] Step 7: clipping logic (100 = fully visible)');
// Visibility: y <= constant (normal (0,-1,0)) -> if constant >= maxY everything is visible
check('100% → plane above the model (fully visible)', clipConstant(100, -20, 20) >= 20);
check('0% → plane below the model (fully clipped)', clipConstant(0, -20, 20) <= -20);
check('50% → plane in the middle', Math.abs(clipConstant(50, -20, 20)) < 0.02);
check('monotonically increasing', (() => {
  let prev = -Infinity;
  for (let p = 0; p <= 100; p += 10) {
    const c = clipConstant(p, -20, 20);
    if (c <= prev) return false;
    prev = c;
  }
  return true;
})());

console.log('\n[30] Step 7: sample model assets (public/models)');
for (const [file, maxKB, expectH] of
  [['bunny.stl', 400, 60], ['dragon.stl', 1024, 60], ['benchy.stl', 11500, 48]]) {
  const buf = readFileSync(new URL(`../public/models/${file}`, import.meta.url));
  check(`${file}: size < ${maxKB}KB`, buf.byteLength < maxKB * 1024,
    `(${(buf.byteLength / 1024).toFixed(0)}KB)`);
  const m = parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  check(`${file}: STL parsed`, m.triVerts.length > 0);
  check(`${file}: manifold (print-ready)`, isMeshManifold(wasm, m.vertProperties, m.triVerts));
  const vol = signedVolume(m.vertProperties, m.triVerts);
  check(`${file}: positive volume (outward-facing normals)`, vol > 0, `(${(vol / 1000).toFixed(1)} cm³)`);
  // Z-up, ~60mm tall, base at z≈0
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 2; i < m.vertProperties.length; i += 3) {
    const z = m.vertProperties[i];
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  check(`${file}: height ≈ ${expectH}mm and base z≈0`,
    Math.abs(maxZ - minZ - expectH) < 0.5 && Math.abs(minZ) < 0.5,
    `(z: ${minZ.toFixed(2)}..${maxZ.toFixed(2)})`);
}
// License note: benchy.stl is CC BY-ND — the file is distributed UNMODIFIED,
// so no transformation (orientation fix, etc.) is expected above.

console.log('\n[31] Step 7: patterns can be applied to sample models (end-to-end)');
{
  const buf = readFileSync(new URL('../public/models/bunny.stl', import.meta.url));
  const m = parseSTL(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const r = applyPattern(wasm, m.vertProperties, m.triVerts,
    { pattern: 'gyroid', cell: 12, wall: 1.6, shell: 1.6, edgeLength: 1.5 });
  check('bunny + gyroid: produced triangles', r.triangles > 0, `(${r.triangles})`);
  check('bunny + gyroid: manifold', isMeshManifold(wasm, r.vertProperties, r.triVerts));
}

console.log('\n[32] Step 7: new i18n keys');
for (const k of ['sampleNames', 'sampleCredits', 'lowTarget', 'generalFolder']) {
  check(`'${k}' exists in the TR and EN dictionaries`,
    Boolean(STRINGS.tr[k]) && Boolean(STRINGS.en[k]));
}
check("sample names include 4 models (knot/bunny/benchy/dragon)",
  ['knot', 'bunny', 'benchy', 'dragon']
    .every((k) => STRINGS.tr.sampleNames[k] && STRINGS.en.sampleNames[k]));
check("'sample_fetch' error code is translated",
  Boolean(STRINGS.tr.errors.sample_fetch && STRINGS.en.errors.sample_fetch));
}

if (SECTIONS.has('library')) {
console.log('\n[33] Library: pure helpers');
const MB = 1024 * 1024;
const mkItems = (...sizes) =>
  sizes.map((s, i) => ({ id: i + 1, date: 1000 + i, size: s * MB }));
check('total size is correct', totalBytes(mkItems(10, 20, 30)) === 60 * MB);
check('under the limit → no pruning', pruneSelection(mkItems(10, 20), 100 * MB).length === 0);
{
  // 4 items × 100MB, limit 250MB → the oldest 2 items (id 1, 2) should be removed
  const ids = pruneSelection(mkItems(100, 100, 100, 100), 250 * MB);
  check('oldest items are selected when the limit is exceeded', JSON.stringify(ids) === '[1,2]', `(${ids})`);
}
{
  // even with dates given out of order, the oldest date is pruned
  const items = [
    { id: 7, date: 500, size: 150 * MB },
    { id: 3, date: 100, size: 150 * MB }
  ];
  const ids = pruneSelection(items, 200 * MB);
  check('sorted by date (not by id)', JSON.stringify(ids) === '[3]', `(${ids})`);
}
check('default limit is 250MB', MAX_LIBRARY_BYTES === 250 * MB);
check('same-model detection (name+size+triangles)',
  isSameModel({ name: 'a.stl', size: 5, triangles: 9 }, { name: 'a.stl', size: 5, triangles: 9 }) &&
  !isSameModel({ name: 'a.stl', size: 5, triangles: 9 }, { name: 'a.stl', size: 6, triangles: 9 }));
check('size formatting', formatSize(500) === '500 B' &&
  formatSize(200 * 1024) === '200 KB' && formatSize(11.3 * MB) === '11.3 MB',
  `(${formatSize(500)}, ${formatSize(200 * 1024)}, ${formatSize(11.3 * MB)})`);

console.log('\n[34] Library: i18n keys');
for (const k of ['library', 'libEmpty', 'libDownload', 'libLoad', 'libDelete',
  'libClear', 'libClearConfirm', 'libKindOriginal']) {
  check(`'${k}' exists in the TR and EN dictionaries`,
    Boolean(STRINGS.tr[k]) && Boolean(STRINGS.en[k]));
}
check("'librarySaved' status text is translated",
  Boolean(STRINGS.tr.status.librarySaved && STRINGS.en.status.librarySaved));
check("'lib_unavailable' error code is translated",
  Boolean(STRINGS.tr.errors.lib_unavailable && STRINGS.en.errors.lib_unavailable));
check('libSummary function works',
  typeof STRINGS.tr.libSummary(3, '12 MB') === 'string' &&
  STRINGS.tr.libSummary(3, '12 MB').includes('3'));
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
