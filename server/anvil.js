'use strict';
/* Liest Blöcke direkt aus Minecraft-Weltordnern (Anvil: region/*.mca). Keine Abhängigkeiten außer core.js. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const B = require('./core.js');

const DIM_DIRS = {
  overworld: ['region', 'dimensions/minecraft/overworld/region'],
  nether: ['DIM-1/region', 'dimensions/minecraft/the_nether/region'],
  end: ['DIM1/region', 'dimensions/minecraft/the_end/region'],
};
const UNKNOWN = 0xFFFF;
const AIR = /^minecraft:(air|cave_air|void_air)$/;

function findDims(world) {
  const out = {};
  for (const [k, cands] of Object.entries(DIM_DIRS)) {
    for (const rel of cands) {
      const d = path.join(world, rel);
      try { if (fs.statSync(d).isDirectory() && fs.readdirSync(d).some((f) => f.endsWith('.mca'))) { out[k] = d; break; } } catch (e) { /* nicht vorhanden */ }
    }
  }
  return out;
}

function readLevel(world) {
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(world, 'level.dat')));
    const d = B.readNBT(new Uint8Array(raw)).value.Data || {};
    const ver = d.Version || {};
    const pl = d.Player || {};
    let player = null;
    if (Array.isArray(pl.Pos) && pl.Pos.length === 3) {
      player = { x: Math.floor(pl.Pos[0]), y: Math.floor(pl.Pos[1]), z: Math.floor(pl.Pos[2]), dim: typeof pl.Dimension === 'string' ? pl.Dimension : null };
    }
    return { name: d.LevelName || path.basename(world), version: ver.Name || null, player, spawn: [d.SpawnX, d.SpawnY, d.SpawnZ] };
  } catch (e) {
    return { name: path.basename(world), version: null, player: null, spawn: null };
  }
}

/* ----------------------------------------------------------- Region-Cache */
const regions = new Map(); /* Pfad -> { mtimeMs, size, buf, chunks: Map } */
function region(dir, rx, rz) {
  const file = path.join(dir, 'r.' + rx + '.' + rz + '.mca');
  let st;
  try { st = fs.statSync(file); } catch (e) { regions.delete(file); return null; }
  let r = regions.get(file);
  if (!r || r.mtimeMs !== st.mtimeMs || r.size !== st.size) {
    r = { mtimeMs: st.mtimeMs, size: st.size, buf: fs.readFileSync(file), chunks: new Map(), dir, rx, rz };
    regions.set(file, r);
  }
  return r;
}


/* Palette-Eintrag lesen; Schlüssel können je nach Version Name/name und Properties/properties heißen. */
function entryOf(e, root, depth) {
  depth = depth || 0;
  if (typeof e === 'string') return { name: e, props: {} };
  const keys = e && typeof e === 'object' ? Object.keys(e) : [];
  const name = e && (e.Name || e.name || e.id || e.Id);
  if (typeof name === 'string' && name) return { name, props: e.Properties || e.properties || e.state || e.State || {} };
  /* Eintrag mit genau einem Schlüssel (auch leer): Inhalt auspacken */
  if (keys.length === 1 && depth < 3 && e[keys[0]] !== undefined && e[keys[0]] !== null && typeof e[keys[0]] !== 'number') {
    if (typeof e[keys[0]] === 'object' || typeof e[keys[0]] === 'string') return entryOf(e[keys[0]], root, depth + 1);
  }
  let preview = '';
  try { preview = JSON.stringify(e, (k, v) => (ArrayBuffer.isView(v) ? '[' + v.constructor.name + ' ' + v.length + ']' : v)).slice(0, 300); } catch (x) { preview = String(e); }
  throw new Error('Unbekanntes Palette-Format im Chunk. Eintrag: ' + preview + ' | Chunk-Wurzel: ' + Object.keys(root).join(','));
}

function decodeChunk(r, lx, lz) {
  const key = lx + lz * 32;
  if (r.chunks.has(key)) return r.chunks.get(key);
  let out = null;
  const buf = r.buf;
  if (buf.length >= 8192) {
    const loc = buf.readUInt32BE(4 * key);
    const sector = loc >>> 8, count = loc & 255;
    if (sector && count && sector * 4096 + 5 <= buf.length) {
      const pos = sector * 4096;
      const len = buf.readUInt32BE(pos);
      let comp = buf[pos + 4];
      let data;
      if (comp & 128) {
        comp &= 127;
        data = fs.readFileSync(path.join(r.dir, 'c.' + (r.rx * 32 + lx) + '.' + (r.rz * 32 + lz) + '.mcc'));
      } else data = buf.subarray(pos + 5, pos + 4 + len);
      let raw;
      if (comp === 1) raw = zlib.gunzipSync(data);
      else if (comp === 2) raw = zlib.inflateSync(data);
      else if (comp === 3) raw = data;
      else throw new Error('Chunk-Kompression ' + comp + ' wird nicht unterstützt (LZ4).');
      const root = B.readNBT(new Uint8Array(raw)).value;
      const secs = root.sections || root.Sections || (root.Level && root.Level.Sections) || [];
      const map = new Map();
      for (const s of secs) {
        const bs = s.block_states || s.BlockStates || s.blockStates;
        const pal = bs && (bs.palette || bs.Palette);
        if (!pal) continue;
        const Y = s.Y !== undefined ? s.Y : s.y;
        map.set(Y, { palette: pal.map((e) => entryOf(e, root, 0)), words: bs.data || bs.Data || null });
      }
      out = { sections: map, status: root.Status || null };
    }
  }
  r.chunks.set(key, out);
  return out;
}

/* Wert eines Blocks im Abschnitt (16x16x16, Index y*256 + z*16 + x). Einträge überspannen keine Longs. */
function sectionIndex(sec, i) {
  const n = sec.palette.length;
  if (n === 1 || !sec.words) return 0;
  const bits = Math.max(4, 32 - Math.clz32(n - 1));
  const per = Math.floor(64 / bits);
  return B.getBits(sec.words, Math.floor(i / per) * 64 + (i % per) * bits, bits);
}

/* Liest einen Quader. Ergebnis: Palette plus Uint16-Gitter im Layout x + z*sx + y*sx*sz.
   Zellen in nicht gespeicherten Chunks sind 0xFFFF. */
function readBox(dir, x0, y0, z0, sx, sy, sz) {
  const grid = new Uint16Array(sx * sy * sz);
  const palette = [{ name: 'minecraft:air', props: {} }];
  const pmap = new Map([['minecraft:air', 0]]);
  const globalOf = (e) => {
    if (AIR.test(e.name)) return 0;
    const k = B.stateKey(e.name, e.props);
    let g = pmap.get(k);
    if (g === undefined) { g = palette.length; palette.push({ name: e.name, props: e.props }); pmap.set(k, g); }
    return g;
  };
  const x1 = x0 + sx, y1 = y0 + sy, z1 = z0 + sz;
  let unknown = 0, newest = 0;
  for (let cz = Math.floor(z0 / 16); cz <= Math.floor((z1 - 1) / 16); cz++) {
    for (let cx = Math.floor(x0 / 16); cx <= Math.floor((x1 - 1) / 16); cx++) {
      const r = region(dir, Math.floor(cx / 32), Math.floor(cz / 32));
      const ch = r ? decodeChunk(r, cx & 31, cz & 31) : null;
      if (r) newest = Math.max(newest, r.mtimeMs);
      const bx0 = Math.max(x0, cx * 16), bx1 = Math.min(x1, cx * 16 + 16);
      const bz0 = Math.max(z0, cz * 16), bz1 = Math.min(z1, cz * 16 + 16);
      if (!ch) {
        for (let y = y0; y < y1; y++) for (let z = bz0; z < bz1; z++) {
          const row = (y - y0) * sx * sz + (z - z0) * sx - x0;
          for (let x = bx0; x < bx1; x++) grid[row + x] = UNKNOWN;
        }
        unknown += (bx1 - bx0) * (bz1 - bz0) * sy;
        continue;
      }
      for (let sY = Math.floor(y0 / 16); sY <= Math.floor((y1 - 1) / 16); sY++) {
        const sec = ch.sections.get(sY);
        if (!sec) continue;
        const local = sec.palette.map(globalOf);
        const by0 = Math.max(y0, sY * 16), by1 = Math.min(y1, sY * 16 + 16);
        for (let y = by0; y < by1; y++) for (let z = bz0; z < bz1; z++) {
          const row = (y - y0) * sx * sz + (z - z0) * sx - x0;
          const base = (y & 15) * 256 + (z & 15) * 16;
          for (let x = bx0; x < bx1; x++) {
            const g = local[sectionIndex(sec, base + (x & 15))];
            if (g) grid[row + x] = g;
          }
        }
      }
    }
  }
  return { size: [sx, sy, sz], palette, grid, unknown, mtime: newest };
}

/* Nur die Signatur der betroffenen Region-Dateien (ohne Lesen), um unveränderte Abfragen billig zu beantworten. */
function boxSignature(dir, x0, z0, sx, sz) {
  const sig = [];
  let newest = 0;
  for (let rz = Math.floor(Math.floor(z0 / 16) / 32); rz <= Math.floor(Math.floor((z0 + sz - 1) / 16) / 32); rz++) {
    for (let rx = Math.floor(Math.floor(x0 / 16) / 32); rx <= Math.floor(Math.floor((x0 + sx - 1) / 16) / 32); rx++) {
      try {
        const st = fs.statSync(path.join(dir, 'r.' + rx + '.' + rz + '.mca'));
        sig.push(rx + '.' + rz + ':' + st.mtimeMs + ':' + st.size); newest = Math.max(newest, st.mtimeMs);
      } catch (e) { /* Region fehlt */ }
    }
  }
  return { sig: sig.sort().join(','), mtime: newest };
}

/* Hilfe bei Formatproblemen: Struktur eines Chunks ohne Blockdaten */
function diagChunk(dir, cx, cz) {
  const r = region(dir, Math.floor(cx / 32), Math.floor(cz / 32));
  if (!r) return { error: 'Region-Datei fehlt' };
  const key = (cx & 31) + (cz & 31) * 32, buf = r.buf;
  const loc = buf.length >= 8192 ? buf.readUInt32BE(4 * key) : 0;
  if (!(loc >>> 8)) return { error: 'Chunk nicht gespeichert' };
  const pos = (loc >>> 8) * 4096, len = buf.readUInt32BE(pos), comp = buf[pos + 4];
  let raw;
  try { raw = comp === 1 ? zlib.gunzipSync(buf.subarray(pos + 5, pos + 4 + len)) : comp === 2 ? zlib.inflateSync(buf.subarray(pos + 5, pos + 4 + len)) : comp === 3 ? buf.subarray(pos + 5, pos + 4 + len) : null; } catch (e) { return { compression: comp, error: String(e.message) }; }
  if (!raw) return { compression: comp, error: 'Kompression nicht unterstützt' };
  const root = B.readNBT(new Uint8Array(raw)).value;
  const secs = root.sections || root.Sections || (root.Level && root.Level.Sections) || [];
  const sec = secs.find((x) => x.block_states || x.BlockStates) || secs[0] || {};
  const bs = sec.block_states || sec.BlockStates || {};
  const pal = bs.palette || bs.Palette || [];
  const cut = (v) => (v && v.length > 3 ? v.slice(0, 3) : v);
  return { compression: comp, rootKeys: Object.keys(root), DataVersion: root.DataVersion, sectionCount: secs.length, sectionKeys: Object.keys(sec), blockStatesKeys: Object.keys(bs), paletteSample: cut(pal), dataLongs: bs.data ? bs.data.length : null };
}


/* ---------------------------------------------------- Datapack-Format der Spielversion
   Liest version.json aus der Minecraft-Jar der Weltversion (Modrinth App, .minecraft, Prism). */
function readZipEntry(file, entry) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, tail = Buffer.alloc(Math.min(size, 70000));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let e = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) return null;
    const cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), n = cd.readUInt16LE(p + 28), m = cd.readUInt16LE(p + 30), k = cd.readUInt16LE(p + 32), lho = cd.readUInt32LE(p + 42);
      if (cd.toString('utf8', p + 46, p + 46 + n) === entry) {
        const lh = Buffer.alloc(30); fs.readSync(fd, lh, 0, 30, lho);
        const data = Buffer.alloc(csize); fs.readSync(fd, data, 0, csize, lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28));
        return method === 0 ? data : zlib.inflateRawSync(data);
      }
      p += 46 + n + m + k;
    }
  } finally { fs.closeSync(fd); }
  return null;
}
function listZipNames(file) {
  const fd = fs.openSync(file, 'r'), names = [];
  try {
    const size = fs.fstatSync(fd).size, tail = Buffer.alloc(Math.min(size, 70000));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let e = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) return names;
    const cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16), cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const n = cd.readUInt16LE(p + 28), m = cd.readUInt16LE(p + 30), k = cd.readUInt16LE(p + 32);
      names.push(cd.toString('utf8', p + 46, p + 46 + n)); p += 46 + n + m + k;
    }
  } finally { fs.closeSync(fd); }
  return names;
}
const blocksCache = new Map();
/* Alle Blöcke der Spielversion (Namen der Blockstate-Dateien in der Minecraft-Jar), oder null wenn nicht lesbar. */
function knownBlocks(world) {
  try {
    const lvl = readLevel(world); if (!lvl.version) return null;
    for (const jar of versionJars(lvl.version)) {
      if (!fs.existsSync(jar)) continue;
      if (blocksCache.has(jar)) return blocksCache.get(jar);
      const list = listZipNames(jar).filter((n) => /^assets\/minecraft\/blockstates\/[^/]+\.json$/.test(n)).map((n) => 'minecraft:' + n.slice(n.lastIndexOf('/') + 1, -5));
      const res = list.length > 500 ? list : null; /* zu kurze Liste: nicht verlässlich */
      blocksCache.set(jar, res); return res;
    }
  } catch (e) { /* unbekannt */ }
  return null;
}
function versionJars(name) {
  const home = require('os').homedir(), out = [];
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const base = process.platform === 'win32' ? appdata : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.local', 'share');
  out.push(path.join(base, 'ModrinthApp', 'meta', 'versions', name, name + '.jar'));
  out.push(path.join(process.platform === 'win32' ? path.join(appdata, '.minecraft') : process.platform === 'darwin' ? path.join(base, 'minecraft') : path.join(home, '.minecraft'), 'versions', name, name + '.jar'));
  out.push(path.join(base, 'PrismLauncher', 'libraries', 'com', 'mojang', 'minecraft', name, 'minecraft-' + name + '-client.jar'));
  return out;
}
function packFormat(world) {
  try {
    const lvl = readLevel(world);
    if (!lvl.version) return null;
    for (const jar of versionJars(lvl.version)) {
      if (!fs.existsSync(jar)) continue;
      const buf = readZipEntry(jar, 'version.json'); if (!buf) continue;
      const pv = JSON.parse(buf.toString('utf8')).pack_version || {};
      const major = pv.data_major !== undefined ? pv.data_major : pv.data;
      if (Number.isFinite(major)) return { major, minor: pv.data_minor || 0, version: lvl.version, jar };
    }
  } catch (e) { /* unbekannt */ }
  return null;
}

module.exports = { knownBlocks, packFormat, diagChunk, findDims, readLevel, readBox, boxSignature, UNKNOWN };
