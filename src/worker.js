// Web Worker: heavy geometry work happens here without freezing the UI.
// Messages carry CODE, not text (i18n is handled on the main thread).
import Module from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import { applyPattern, isMeshManifold } from './pipeline.js';
import { applyShellCut } from './shellcut.js';
import { simplifyArrays } from './simplify.js';
import { applyTexture } from './textures.js';
import { signedVolume } from './stl.js';

let wasmPromise = null;
function getWasm() {
  if (!wasmPromise) {
    wasmPromise = Module().then((w) => { w.setup(); return w; });
  }
  return wasmPromise;
}

self.onmessage = async (e) => {
  const { id, vertProperties, triVerts, params } = e.data;
  const progress = (key, arg) => self.postMessage({ id, type: 'progress', key, arg });
  try {
    if (params.mode === 'check') {
      // Manifold (print-readiness) check for the loaded model
      const wasm = await getWasm();
      const manifoldOK = isMeshManifold(wasm, vertProperties, triVerts);
      self.postMessage({ id, type: 'done', mode: 'check', manifoldOK });
      return;
    }

    let out;
    if (params.mode === 'simplify') {
      progress('simplifying');
      const originalVolume = Math.abs(signedVolume(vertProperties, triVerts));
      const s = await simplifyArrays(MeshoptSimplifier, vertProperties, triVerts, params.ratio);
      progress('checking');
      const wasm = await getWasm();
      const manifoldOK = isMeshManifold(wasm, s.vertProperties, s.triVerts);
      out = {
        vertProperties: s.vertProperties,
        triVerts: s.triVerts,
        triangles: s.triangles,
        volume: Math.abs(signedVolume(s.vertProperties, s.triVerts)),
        originalVolume,
        warning: manifoldOK ? null : 'simplify_not_manifold',
        manifoldOK,
        mode: 'simplify'
      };
    } else if (params.mode === 'texture') {
      const t = applyTexture(vertProperties, triVerts, params, progress);
      progress('checking');
      const wasm = await getWasm();
      out = {
        vertProperties: t.vertProperties,
        triVerts: t.triVerts,
        triangles: t.triangles,
        volume: Math.abs(signedVolume(t.vertProperties, t.triVerts)),
        warning: t.warning,
        manifoldOK: isMeshManifold(wasm, t.vertProperties, t.triVerts),
        mode: 'texture'
      };
    } else if (params.mode === 'shell') {
      progress('engine');
      const wasm = await getWasm();
      out = applyShellCut(wasm, vertProperties, triVerts, params, progress);
      progress('checking');
      out.manifoldOK = isMeshManifold(wasm, out.vertProperties, out.triVerts);
      out.mode = 'shell';
    } else {
      progress('engine');
      const wasm = await getWasm();
      out = applyPattern(wasm, vertProperties, triVerts, params, progress);
      progress('checking');
      out.manifoldOK = isMeshManifold(wasm, out.vertProperties, out.triVerts);
      out.mode = 'pattern';
    }
    self.postMessage(
      { id, type: 'done', ...out },
      [out.vertProperties.buffer, out.triVerts.buffer]
    );
  } catch (err) {
    self.postMessage({
      id, type: 'error',
      code: (err && err.code) || null,
      message: String((err && err.message) || err)
    });
  }
};
