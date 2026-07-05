// Library: STL files downloaded by the user (result + original) are stored
// in IndexedDB on the same device and can later be re-downloaded / restored.
// Meta and binary data are kept in separate stores — megabytes of buffers
// aren't loaded into memory just to open the list. Pure helpers are verified in Node tests.

const DB_NAME = 'pds-library';
const DB_VERSION = 1;

/** Total storage limit — oldest items are pruned if exceeded. */
export const MAX_LIBRARY_BYTES = 250 * 1024 * 1024;

/* ---------- pure helpers (tested in Node) ---------- */

/** Total size of items (bytes). */
export function totalBytes(items) {
  return items.reduce((sum, it) => sum + (it.size || 0), 0);
}

/**
 * Item ids to delete once the limit is exceeded: starting from oldest,
 * until under the total limit.
 */
export function pruneSelection(items, maxBytes = MAX_LIBRARY_BYTES) {
  let total = totalBytes(items);
  if (total <= maxBytes) return [];
  const sorted = [...items].sort((a, b) => a.date - b.date); // oldest -> newest
  const ids = [];
  for (const it of sorted) {
    if (total <= maxBytes) break;
    ids.push(it.id);
    total -= it.size || 0;
  }
  return ids;
}

/** Same model? (name + size + triangle comparison, to prevent duplicate records) */
export function isSameModel(a, b) {
  return a.name === b.name && a.size === b.size && a.triangles === b.triangles;
}

/** Human-readable size: 843 KB, 11.3 MB ... */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ---------- IndexedDB access (browser) ---------- */

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Opens the database; rejects if IndexedDB is unavailable (UI disables the button). */
export function openLibrary() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Adds an item. meta: { name, kind, triangles, date } — size is taken from the buffer.
 * @returns new id
 */
export function addItem(db, meta, buffer) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta', 'blobs'], 'readwrite');
    tx.onerror = () => reject(tx.error);
    const record = { ...meta, size: buffer.byteLength };
    const addReq = tx.objectStore('meta').add(record);
    addReq.onsuccess = () => {
      const id = addReq.result;
      tx.objectStore('blobs').put({ id, buffer });
      tx.oncomplete = () => resolve(id);
    };
  });
}

/** Metadata for all items, newest first (buffers are not loaded). */
export async function listItems(db) {
  const items = await reqAsPromise(db.transaction('meta').objectStore('meta').getAll());
  return items.sort((a, b) => b.date - a.date);
}

/** STL buffer for a single item. */
export async function getBuffer(db, id) {
  const rec = await reqAsPromise(db.transaction('blobs').objectStore('blobs').get(id));
  return rec ? rec.buffer : null;
}

/** Deletes an item (meta + blob). */
export function deleteItem(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta', 'blobs'], 'readwrite');
    tx.objectStore('meta').delete(id);
    tx.objectStore('blobs').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Fully empties the library. */
export function clearAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta', 'blobs'], 'readwrite');
    tx.objectStore('meta').clear();
    tx.objectStore('blobs').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
