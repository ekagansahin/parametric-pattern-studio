import * as THREE from 'three';
import GUI from 'lil-gui';
import { Viewer } from './viewer.js';
import { parseSTL, exportSTL, geometryToArrays, signedVolume, boundsOf } from './stl.js';
import { targetFromRatio, ratioFromTarget } from './simplify.js';
import {
  openLibrary, addItem, listItems, getBuffer, deleteItem, clearAll,
  pruneSelection, isSameModel, formatSize, totalBytes
} from './library.js';
import { STRINGS, getLang, setLang } from './i18n.js';

let lang = getLang();

/** Number/date locale that matches the UI language (not the browser's). */
const uiLocale = () => (lang === 'tr' ? 'tr-TR' : 'en-US');
/** Percent in the UI language's convention: "%53" in Turkish, "53%" in English. */
const fmtPercent = (v) => (lang === 'tr' ? `%${v}` : `${v}%`);
let L = STRINGS[lang];

const viewer = new Viewer(document.getElementById('viewport'));
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const hintEl = document.getElementById('hint');
const dropEl = document.getElementById('dropzone');
const panelsEl = document.getElementById('panels');
const creditEl = document.getElementById('credit');
const demoMenuEl = document.getElementById('demoMenu');
const libraryEl = document.getElementById('library');
const libListEl = document.getElementById('libList');

let original = null;   // { vertProperties, triVerts, name, manifoldOK? }
let result = null;     // { vertProperties, triVerts, volume, mode, resolution?, manifoldOK? }
let busy = false;
let jobId = 0;
let checkSeq = 0;

/* ---------- durum / istatistik ---------- */

function setStatus(msg, isBusy = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('busy', isBusy);
}

function localizeError(data) {
  return (data.code && L.errors[data.code]) || data.message;
}

function showStats() {
  const src = result || original;
  if (!src) return;
  const { min, max } = boundsOf(src.vertProperties);
  const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    .map((v) => v.toFixed(1)).join(' × ');
  const vol = src.volume ?? Math.abs(signedVolume(src.vertProperties, src.triVerts));
  let text =
    `${L.stats.tri}: ${(src.triVerts.length / 3).toLocaleString(uiLocale())}\n` +
    `${L.stats.size}: ${dims} mm\n` +
    `${L.stats.volume}: ${(vol / 1000).toFixed(1)} cm³`;
  if (result && result.originalVolume) {
    text += `\n${L.stats.fill}: ${fmtPercent(((vol / result.originalVolume) * 100).toFixed(0))}`;
  }
  if (src.manifoldOK !== undefined) {
    text += `\n${src.manifoldOK ? L.stats.printable : L.stats.notPrintable}`;
  }
  statsEl.textContent = text;
  statsEl.style.display = 'block';
}

function showCurrent() {
  const src = result || original;
  if (!src) return;
  viewer.setMesh(src.vertProperties.slice(), src.triVerts.slice());
  showStats();
  refreshLowTarget();
}

/** Source for low-poly (chained: the result if present, otherwise the original). */
function sourceTriCount() {
  const src = result || original;
  return src ? src.triVerts.length / 3 : 0;
}

/** Refreshes the target triangle count from the current ratio and the loaded model. */
function refreshLowTarget() {
  params.lowTarget = targetFromRatio(params.lowRatio, sourceTriCount());
  if (lowTargetCtrl) lowTargetCtrl.updateDisplay();
}

/* ---------- model loading ---------- */

function loadArrays(arrays, name, creditKey = null) {
  original = { ...arrays, name };
  result = null;
  hintEl.style.display = 'none';
  const credit = creditKey && L.sampleCredits[creditKey];
  creditEl.textContent = credit || '';
  creditEl.style.display = credit ? 'block' : 'none';
  creditEl.dataset.key = creditKey || '';
  showCurrent();
  setStatus(L.status.loaded(name));
  // Manifold (print-readiness) check in the background
  const seq = ++checkSeq;
  worker.postMessage({
    id: `check-${seq}`,
    vertProperties: original.vertProperties.slice(),
    triVerts: original.triVerts.slice(),
    params: { mode: 'check' }
  });
}

async function loadFile(file) {
  try {
    setStatus(L.progress.reading(file.name), true);
    const buffer = await file.arrayBuffer();
    const arrays = parseSTL(buffer);
    loadArrays(arrays, file.name);
  } catch (e) {
    setStatus(L.status.errPrefix + ((e.code && L.errors[e.code]) || e.message));
  }
}

document.getElementById('btnFile').onclick = () => document.getElementById('file').click();
document.getElementById('file').onchange = (e) => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
  e.target.value = '';
};
/* ---------- sample models (Step 7) ---------- */

const SAMPLES = {
  knot: { procedural: true },
  bunny: { file: 'models/bunny.stl' },
  benchy: { file: 'models/benchy.stl' },
  dragon: { file: 'models/dragon.stl' }
};

async function loadSample(key) {
  const def = SAMPLES[key];
  if (!def) return;
  demoMenuEl.classList.remove('open');
  if (def.procedural) {
    const geo = new THREE.TorusKnotGeometry(28, 9, 160, 36);
    loadArrays(geometryToArrays(geo), lang === 'tr' ? 'ornek-dugum.stl' : 'sample-knot.stl');
    return;
  }
  try {
    setStatus(L.progress.reading(L.sampleNames[key]), true);
    const res = await fetch(def.file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrays = parseSTL(await res.arrayBuffer());
    loadArrays(arrays, def.file.split('/').pop(), key);
  } catch {
    setStatus(L.status.errPrefix + L.errors.sample_fetch);
  }
}

function buildDemoMenu() {
  demoMenuEl.innerHTML = '';
  for (const key of Object.keys(SAMPLES)) {
    const b = document.createElement('button');
    b.textContent = L.sampleNames[key];
    b.onclick = () => loadSample(key);
    demoMenuEl.appendChild(b);
  }
}
document.getElementById('btnDemo').onclick = (e) => {
  e.stopPropagation();
  demoMenuEl.classList.toggle('open');
};
window.addEventListener('click', (e) => {
  if (!demoMenuEl.contains(e.target)) demoMenuEl.classList.remove('open');
});

window.addEventListener('dragover', (e) => { e.preventDefault(); dropEl.style.display = 'flex'; });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dropEl.style.display = 'none'; });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropEl.style.display = 'none';
  const f = e.dataTransfer.files[0];
  if (f && /\.stl$/i.test(f.name)) loadFile(f);
  else setStatus(L.status.notStl);
});

/* ---------- worker ---------- */

let pendingResolution = null;

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.onmessage = (e) => {
  const { id, type } = e.data;

  // Manifold-check jobs (background)
  if (type === 'done' && e.data.mode === 'check') {
    if (id === `check-${checkSeq}` && original) {
      original.manifoldOK = e.data.manifoldOK;
      if (!result) showStats();
    }
    return;
  }
  if (typeof id === 'string') return; // stale check jobs

  if (id !== jobId) return; // message from a stale job
  if (type === 'progress') {
    const p = L.progress[e.data.key];
    setStatus(typeof p === 'function' ? p(e.data.arg) : (p || e.data.key), true);
  } else if (type === 'done') {
    busy = false;
    result = {
      vertProperties: e.data.vertProperties,
      triVerts: e.data.triVerts,
      volume: e.data.volume,
      originalVolume: e.data.originalVolume,
      manifoldOK: e.data.manifoldOK,
      mode: e.data.mode,
      suffix: pendingSuffix,
      resolution: e.data.mode === 'pattern' ? pendingResolution : null
    };
    if (e.data.mode === 'simplify' && !params.flat) {
      params.flat = true;
      viewer.setFlat(true);
      allControllers().forEach((c) => c.updateDisplay());
    }
    showCurrent();
    const warn = e.data.warning
      ? ` — ${L.status.warnPrefix}${L.warn[e.data.warning] || e.data.warning}` : '';
    const nTri = e.data.triangles.toLocaleString(uiLocale());
    const base = e.data.mode === 'simplify' ? L.status.simplified(nTri)
      : e.data.mode === 'texture' ? L.status.textured(nTri)
      : e.data.mode === 'shell' ? L.status.shelled(nTri)
      : L.status.applied(nTri);
    setStatus(base + warn);
  } else if (type === 'error') {
    busy = false;
    setStatus(L.status.errPrefix + localizeError(e.data));
  }
};
worker.onerror = (e) => { busy = false; setStatus(L.status.errPrefix + e.message); };

/* ---------- parametreler ---------- */

const RES = { draft: 5, normal: 8, high: 12 };
let pendingSuffix = null;

const params = {
  pattern: 'gyroid',
  cell: 10,
  wall: 1.2,
  shell: 1.6,
  resolution: 'normal',
  lowRatio: 25,
  flat: false,
  texture: 'noise',
  texScale: 8,
  texDepth: 1,
  texAutoSub: true,
  shellVariant: 'voronoiShell',
  holeSize: 8,
  strut: 2,
  shellThickness: 2,
  shellResolution: 'normal',
  lowTarget: 0,
  clip: 100,
  apply() {
    if (!original) { setStatus(L.status.noModel); return; }
    if (busy) return;
    busy = true;
    jobId++;
    pendingResolution = params.resolution;
    pendingSuffix = params.pattern;
    worker.postMessage({
      id: jobId,
      vertProperties: original.vertProperties.slice(),
      triVerts: original.triVerts.slice(),
      params: {
        mode: 'pattern',
        pattern: params.pattern,
        cell: params.cell,
        wall: params.wall,
        shell: params.shell,
        edgeLength: params.cell / RES[params.resolution]
      }
    });
    setStatus(L.progress.queued, true);
  },
  simplify() {
    const src = result || original;
    if (!src) { setStatus(L.status.noModel); return; }
    if (busy) return;
    busy = true;
    jobId++;
    pendingSuffix = 'lowpoly';
    worker.postMessage({
      id: jobId,
      vertProperties: src.vertProperties.slice(),
      triVerts: src.triVerts.slice(),
      params: { mode: 'simplify', ratio: params.lowRatio / 100 }
    });
    setStatus(L.progress.queued, true);
  },
  texApply() {
    const src = result || original;
    if (!src) { setStatus(L.status.noModel); return; }
    if (busy) return;
    busy = true;
    jobId++;
    pendingSuffix = params.texture;
    worker.postMessage({
      id: jobId,
      vertProperties: src.vertProperties.slice(),
      triVerts: src.triVerts.slice(),
      params: {
        mode: 'texture',
        texture: params.texture,
        scale: params.texScale,
        depth: params.texDepth,
        subdiv: params.texAutoSub ? 'auto' : 'off'
      }
    });
    setStatus(L.progress.queued, true);
  },
  shellApply() {
    if (!original) { setStatus(L.status.noModel); return; }
    if (busy) return;
    busy = true;
    jobId++;
    pendingSuffix = params.shellVariant === 'delaunay' ? 'delaunay' : 'voronoi-shell';
    worker.postMessage({
      id: jobId,
      vertProperties: original.vertProperties.slice(),
      triVerts: original.triVerts.slice(),
      params: {
        mode: 'shell',
        variant: params.shellVariant,
        holeSize: params.holeSize,
        strut: params.strut,
        thickness: params.shellThickness,
        // resolution based on strut thickness: draft/normal/high
        edgeLength: (params.strut * 4) / RES[params.shellResolution]
      }
    });
    setStatus(L.progress.queued, true);
  },
  useResult() {
    if (!result) { setStatus(L.status.noResult); return; }
    original = {
      vertProperties: result.vertProperties,
      triVerts: result.triVerts,
      name: original.name,
      manifoldOK: result.manifoldOK
    };
    result = null;
    showCurrent();
    setStatus(L.status.resultAsInput);
  },
  reset() {
    result = null;
    if (original) { showCurrent(); setStatus(L.status.showingOriginal); }
  },
  download() {
    const src = result || original;
    if (!src) { setStatus(L.status.noDownload); return; }
    const buffer = exportSTL(src.vertProperties, src.triVerts);
    const name = (original.name || 'model.stl').replace(/\.stl$/i, '');
    const suffix = result && result.suffix ? `_${result.suffix}` : '';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buffer], { type: 'model/stl' }));
    a.download = `${name}${suffix}.stl`;
    a.click();
    URL.revokeObjectURL(a.href);
    const draftNote = (result && result.mode === 'pattern' && result.resolution === 'draft')
      ? L.status.draftNote : '';
    setStatus(L.status.downloaded(a.download) + draftNote);

    // Save to library: the downloaded file + (if a result) its original
    const entries = [{
      name: a.download,
      kind: result ? (result.suffix || result.mode) : 'original',
      triangles: src.triVerts.length / 3,
      buffer
    }];
    if (result && original) {
      entries.push({
        name: original.name || 'model.stl',
        kind: 'original',
        triangles: original.triVerts.length / 3,
        buffer: exportSTL(original.vertProperties, original.triVerts)
      });
    }
    saveToLibrary(entries).then((added) => {
      if (added) statusEl.textContent += ` ${L.status.librarySaved}`;
    });
  },
  toggleLang() {
    lang = lang === 'tr' ? 'en' : 'tr';
    setLang(lang);
    L = STRINGS[lang];
    applyStaticTexts();
    buildDemoMenu();
    buildGui();
    if (creditEl.dataset.key) creditEl.textContent = L.sampleCredits[creditEl.dataset.key] || '';
    if (libraryEl.classList.contains('open')) renderLibrary();
    if (original || result) showStats();
    setStatus(L.ready);
  }
};

/* ---------- library (STLs stored on the device) ---------- */

let libDb = null;
openLibrary().then((db) => { libDb = db; }).catch(() => { libDb = null; });

/** Adds items while skipping duplicates, pruning the oldest ones if the limit is exceeded. */
async function saveToLibrary(entries) {
  if (!libDb) return false;
  try {
    const existing = await listItems(libDb);
    let added = false;
    for (const e of entries) {
      const probe = { name: e.name, size: e.buffer.byteLength, triangles: e.triangles };
      if (existing.some((x) => isSameModel(x, probe))) continue;
      await addItem(libDb, {
        name: e.name, kind: e.kind, triangles: e.triangles, date: Date.now()
      }, e.buffer);
      added = true;
    }
    if (added) {
      const items = await listItems(libDb);
      for (const id of pruneSelection(items)) await deleteItem(libDb, id);
    }
    return added;
  } catch {
    return false;
  }
}

async function renderLibrary() {
  const head = libraryEl.querySelector('#libHead');
  head.querySelector('.title').textContent = L.library;
  document.getElementById('libClear').textContent = L.libClear;
  libListEl.innerHTML = '';
  if (!libDb) {
    libListEl.innerHTML = `<div id="libEmpty">${L.errors.lib_unavailable}</div>`;
    head.querySelector('.summary').textContent = '';
    return;
  }
  const items = await listItems(libDb);
  head.querySelector('.summary').textContent =
    items.length ? L.libSummary(items.length, formatSize(totalBytes(items))) : '';
  if (items.length === 0) {
    libListEl.innerHTML = `<div id="libEmpty">${L.libEmpty}</div>`;
    return;
  }
  const locale = uiLocale();
  for (const it of items) {
    const div = document.createElement('div');
    div.className = 'lib-item';
    const top = document.createElement('div');
    top.className = 'row';
    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = it.name;
    nameEl.title = it.name;
    const kindEl = document.createElement('span');
    kindEl.className = 'kind';
    kindEl.textContent = it.kind === 'original' ? L.libKindOriginal : it.kind;
    top.append(nameEl, kindEl);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${new Date(it.date).toLocaleString(locale)} · ` +
      `${it.triangles.toLocaleString(locale)} ${L.stats.tri.toLowerCase()} · ${formatSize(it.size)}`;

    const row = document.createElement('div');
    row.className = 'row';
    const mkBtn = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = `mini ${cls}`;
      b.textContent = label;
      b.onclick = fn;
      return b;
    };
    row.append(
      mkBtn(L.libDownload, '', async () => {
        const buf = await getBuffer(libDb, it.id);
        if (!buf) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([buf], { type: 'model/stl' }));
        a.download = it.name;
        a.click();
        URL.revokeObjectURL(a.href);
        setStatus(L.status.downloaded(it.name));
      }),
      mkBtn(L.libLoad, '', async () => {
        try {
          const buf = await getBuffer(libDb, it.id);
          if (!buf) return;
          loadArrays(parseSTL(buf), it.name);
          libraryEl.classList.remove('open');
        } catch (e) {
          setStatus(L.status.errPrefix + ((e.code && L.errors[e.code]) || e.message));
        }
      }),
      mkBtn(L.libDelete, 'danger', async () => {
        await deleteItem(libDb, it.id);
        renderLibrary();
      })
    );
    div.append(top, meta, row);
    libListEl.appendChild(div);
  }
}

document.getElementById('btnLibrary').onclick = () => {
  const opening = !libraryEl.classList.contains('open');
  libraryEl.classList.toggle('open');
  if (opening) renderLibrary();
};
document.getElementById('libClose').onclick = () => libraryEl.classList.remove('open');
document.getElementById('libClear').onclick = async () => {
  if (!libDb) return;
  if (!window.confirm(L.libClearConfirm)) return;
  await clearAll(libDb);
  renderLibrary();
};

/* ---------- UI text + GUI (Step 7: independent panels) ---------- */

function applyStaticTexts() {
  document.title = L.title;
  document.documentElement.lang = lang;
  document.getElementById('appTitle').textContent = L.title;
  document.getElementById('btnFile').textContent = L.loadStl;
  document.getElementById('btnDemo').textContent = `${L.demo} ▾`;
  document.getElementById('btnLibrary').textContent = L.library;
  document.getElementById('btnLang').textContent = L.langBtn;
  document.getElementById('hintBig').textContent = L.hintBig;
  document.getElementById('hintSmall').textContent = L.hintSmall;
  dropEl.textContent = L.dropHere;
}
document.getElementById('btnLang').onclick = () => params.toggleLang();

function optionsOf(dict) {
  const opts = {};
  for (const [key, name] of Object.entries(dict)) opts[name] = key;
  return opts;
}

let guis = [];
let lowTargetCtrl = null;

function makePanel(title) {
  const div = document.createElement('div');
  panelsEl.appendChild(div);
  const g = new GUI({ title, container: div });
  guis.push(g);
  return g;
}

function allControllers() {
  return guis.flatMap((g) => g.controllersRecursive());
}

function buildGui() {
  guis.forEach((g) => g.destroy());
  guis = [];
  lowTargetCtrl = null;
  panelsEl.innerHTML = '';

  // 1) Infill (pattern)
  const gp = makePanel(L.guiTitle);
  gp.add(params, 'pattern', optionsOf(L.patternNames)).name(L.pattern);
  gp.add(params, 'cell', 3, 50, 0.5).name(L.cell);
  gp.add(params, 'wall', 0.4, 6, 0.1).name(L.wall);
  gp.add(params, 'shell', 0, 6, 0.1).name(L.shell);
  gp.add(params, 'resolution', optionsOf(L.resOptions)).name(L.resolution);
  gp.add(params, 'apply').name(L.apply);

  // 2) Shell perforation
  const gs = makePanel(L.shellFolder);
  gs.add(params, 'shellVariant', optionsOf(L.shellVariantNames)).name(L.shellVariant);
  gs.add(params, 'holeSize', 3, 40, 0.5).name(L.holeSize);
  gs.add(params, 'strut', 0.8, 6, 0.1).name(L.strut);
  gs.add(params, 'shellThickness', 0.8, 6, 0.1).name(L.shellThickness);
  gs.add(params, 'shellResolution', optionsOf(L.resOptions)).name(L.resolution);
  gs.add(params, 'shellApply').name(L.shellApply);

  // 3) Surface texture
  const gt = makePanel(L.texFolder);
  gt.add(params, 'texture', optionsOf(L.texNames)).name(L.texture);
  gt.add(params, 'texScale', 3, 30, 0.5).name(L.texScale);
  gt.add(params, 'texDepth', 0.2, 5, 0.1).name(L.texDepth);
  gt.add(params, 'texAutoSub').name(L.texSubdiv);
  gt.add(params, 'texApply').name(L.texApply);

  // 4) Low-poly — ratio <-> target cross-check
  const gl = makePanel(L.lowFolder);
  gl.add(params, 'lowRatio', 2, 90, 1).name(L.ratio).onChange(() => {
    params.lowTarget = targetFromRatio(params.lowRatio, sourceTriCount());
    if (lowTargetCtrl) lowTargetCtrl.updateDisplay();
  });
  lowTargetCtrl = gl.add(params, 'lowTarget').name(L.lowTarget).onFinishChange(() => {
    params.lowRatio = Math.round(ratioFromTarget(params.lowTarget, sourceTriCount()));
    params.lowTarget = targetFromRatio(params.lowRatio, sourceTriCount());
    allControllers().forEach((c) => c.updateDisplay());
  });
  gl.add(params, 'simplify').name(L.simplify);
  gl.add(params, 'flat').name(L.flat).onChange((v) => viewer.setFlat(v));

  // 5) General (view + file operations)
  const gg = makePanel(L.generalFolder);
  gg.add(params, 'clip', 0, 100, 1).name(L.clip).onChange((v) => viewer.setClip(v));
  gg.add(params, 'reset').name(L.reset);
  gg.add(params, 'useResult').name(L.useResult);
  gg.add(params, 'download').name(L.download);

  // Default: pattern panel open, others closed (side-by-side title bars)
  [gs, gt, gl].forEach((g) => g.close());
  refreshLowTarget();
}

applyStaticTexts();
buildDemoMenu();
buildGui();
setStatus(L.ready);
