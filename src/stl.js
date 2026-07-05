// STL read/write. Dependency-free — runs in both the browser and Node.
// Data model: vertProperties (Float32Array, xyz*N), triVerts (Uint32Array, 3*T)

/** Parses an STL from an ArrayBuffer (binary + ASCII auto-detected). */
function codedError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function parseSTL(buffer) {
  if (buffer.byteLength < 15) throw codedError('File too small — not a valid STL.', 'file_small');

  // Binary detection: expected size = 84 + 50 * triangle count
  if (buffer.byteLength >= 84) {
    const dv = new DataView(buffer);
    const triCount = dv.getUint32(80, true);
    if (84 + triCount * 50 === buffer.byteLength) return parseBinary(dv, triCount);
  }
  const text = new TextDecoder().decode(buffer);
  if (/^\s*solid/.test(text) && /facet/i.test(text)) return parseASCII(text);
  // Last-resort attempt for corrupt binaries whose size doesn't match and don't start with "solid":
  if (buffer.byteLength >= 84) {
    const dv = new DataView(buffer);
    const triCount = Math.floor((buffer.byteLength - 84) / 50);
    if (triCount > 0) return parseBinary(dv, triCount);
  }
  throw codedError('Unrecognized STL format.', 'bad_format');
}

function parseBinary(dv, triCount) {
  const vertProperties = new Float32Array(triCount * 9);
  const triVerts = new Uint32Array(triCount * 3);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    off += 12; // face normal (recomputed later, skip)
    for (let v = 0; v < 3; v++) {
      const i = (t * 3 + v) * 3;
      vertProperties[i] = dv.getFloat32(off, true);
      vertProperties[i + 1] = dv.getFloat32(off + 4, true);
      vertProperties[i + 2] = dv.getFloat32(off + 8, true);
      off += 12;
      triVerts[t * 3 + v] = t * 3 + v;
    }
    off += 2; // attribute byte count
  }
  return { vertProperties, triVerts };
}

function parseASCII(text) {
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  const coords = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    coords.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  }
  if (coords.length === 0 || coords.length % 9 !== 0) {
    throw codedError('Could not parse ASCII STL.', 'ascii_fail');
  }
  const vertProperties = new Float32Array(coords);
  const triVerts = new Uint32Array(coords.length / 3);
  for (let i = 0; i < triVerts.length; i++) triVerts[i] = i;
  return { vertProperties, triVerts };
}

/** Generates a binary STL. */
export function exportSTL(vertProperties, triVerts) {
  const triCount = triVerts.length / 3;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buffer);
  const header = 'Parametric Pattern Studio';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, triCount, true);
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    const a = triVerts[t * 3] * 3, b = triVerts[t * 3 + 1] * 3, c = triVerts[t * 3 + 2] * 3;
    const ax = vertProperties[a], ay = vertProperties[a + 1], az = vertProperties[a + 2];
    const bx = vertProperties[b], by = vertProperties[b + 1], bz = vertProperties[b + 2];
    const cx = vertProperties[c], cy = vertProperties[c + 1], cz = vertProperties[c + 2];
    // face normal
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
    dv.setFloat32(off + 12, ax, true); dv.setFloat32(off + 16, ay, true); dv.setFloat32(off + 20, az, true);
    dv.setFloat32(off + 24, bx, true); dv.setFloat32(off + 28, by, true); dv.setFloat32(off + 32, bz, true);
    dv.setFloat32(off + 36, cx, true); dv.setFloat32(off + 40, cy, true); dv.setFloat32(off + 44, cz, true);
    dv.setUint16(off + 48, 0, true);
    off += 50;
  }
  return buffer;
}

/** Three.js BufferGeometry -> array pair (for sample models). */
export function geometryToArrays(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.getAttribute('position');
  const vertProperties = new Float32Array(pos.array);
  const triVerts = new Uint32Array(pos.count);
  for (let i = 0; i < pos.count; i++) triVerts[i] = i;
  return { vertProperties, triVerts };
}

/** Signed volume (mm³) — for stats. */
export function signedVolume(vertProperties, triVerts) {
  let vol = 0;
  for (let t = 0; t < triVerts.length; t += 3) {
    const a = triVerts[t] * 3, b = triVerts[t + 1] * 3, c = triVerts[t + 2] * 3;
    const ax = vertProperties[a], ay = vertProperties[a + 1], az = vertProperties[a + 2];
    const bx = vertProperties[b], by = vertProperties[b + 1], bz = vertProperties[b + 2];
    const cx = vertProperties[c], cy = vertProperties[c + 1], cz = vertProperties[c + 2];
    vol += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

/** Bounding box. */
export function boundsOf(vertProperties) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertProperties.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = vertProperties[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}
