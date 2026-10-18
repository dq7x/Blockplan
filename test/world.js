/* Erzeugt einen synthetischen Minecraft-Weltordner (Anvil) für Tests. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { T, nbt, I, S, C, L, BY, D } = require('./nbtw.js');

function sectionNbt(sy, states) { /* states: 4096 Strings "name[props]" oder 'minecraft:air' */
  const keys = [...new Set(states)];
  const parse = (k) => { const i = k.indexOf('['); const name = i < 0 ? k : k.slice(0, i); const props = {}; if (i >= 0) k.slice(i + 1, -1).split(',').forEach((kv) => { const [a, b] = kv.split('='); props[a] = b; }); return { name, props }; };
  const palette = L(T.comp, keys.map((k) => { const p = parse(k); const o = { Name: S(p.name) }; if (Object.keys(p.props).length) o.Properties = C(Object.fromEntries(Object.entries(p.props).map(([a, b]) => [a, S(b)]))); return o; }));
  const bs = { palette };
  if (keys.length > 1) {
    const bits = Math.max(4, Math.ceil(Math.log2(keys.length)));
    const per = Math.floor(64 / bits), nl = Math.ceil(4096 / per);
    const longs = new Array(nl).fill(0n);
    states.forEach((k, i) => { longs[Math.floor(i / per)] |= BigInt(keys.indexOf(k)) << BigInt((i % per) * bits); });
    bs.data = [T.longs, longs.map((x) => BigInt.asIntN(64, x))];
  }
  return { Y: BY(sy), block_states: C(bs) };
}

/* blockAt(x,y,z) -> State-String. chunks: Liste [cx,cz]. yMin..yMax in Blöcken. */
function chunkBytes(cx, cz, blockAt, yMin, yMax) {
  const secs = [];
  for (let sy = Math.floor(yMin / 16); sy <= Math.floor(yMax / 16); sy++) {
    const st = new Array(4096);
    let any = false;
    for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      const b = blockAt(cx * 16 + x, sy * 16 + y, cz * 16 + z) || 'minecraft:air';
      if (b !== 'minecraft:air') any = true;
      st[y * 256 + z * 16 + x] = b;
    }
    if (any || sy === Math.floor(yMin / 16)) secs.push(sectionNbt(sy, st));
  }
  return nbt('', { DataVersion: I(4600), xPos: I(cx), zPos: I(cz), Status: S('minecraft:full'), sections: L(T.comp, secs) });
}

function writeRegion(file, chunks) { /* chunks: Map(localIndex -> {data:Buffer, comp:1|2}) */
  const parts = [Buffer.alloc(4096), Buffer.alloc(4096)];
  let sector = 2;
  for (const [idx, { data, comp }] of chunks) {
    const z = comp === 1 ? zlib.gzipSync(data) : zlib.deflateSync(data);
    const body = Buffer.alloc(5 + z.length); body.writeUInt32BE(z.length + 1, 0); body[4] = comp; z.copy(body, 5);
    const nsec = Math.ceil(body.length / 4096);
    const padded = Buffer.alloc(nsec * 4096); body.copy(padded);
    parts[0].writeUInt32BE((sector << 8) | nsec, idx * 4);
    parts.push(padded); sector += nsec;
  }
  fs.writeFileSync(file, Buffer.concat(parts));
}

function makeWorld(dir, blockAt, chunkList, opts) {
  opts = opts || {};
  fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
  const byRegion = new Map();
  chunkList.forEach(([cx, cz], n) => {
    const rx = Math.floor(cx / 32), rz = Math.floor(cz / 32);
    const k = rx + ',' + rz;
    if (!byRegion.has(k)) byRegion.set(k, { rx, rz, chunks: new Map() });
    byRegion.get(k).chunks.set((cx & 31) + (cz & 31) * 32, { data: chunkBytes(cx, cz, blockAt, opts.yMin ?? -64, opts.yMax ?? 63), comp: n % 3 === 0 ? 1 : 2 });
  });
  for (const r of byRegion.values()) writeRegion(path.join(dir, 'region', 'r.' + r.rx + '.' + r.rz + '.mca'), r.chunks);
  const level = nbt('', { Data: C({ LevelName: S(opts.name || path.basename(dir)), Version: C({ Name: S('26.3') }), SpawnX: I(0), SpawnY: I(64), SpawnZ: I(0),
    Player: C({ Pos: L(T.double, [10.5, 70, -20.2]), Dimension: S('minecraft:overworld') }) }) });
  fs.writeFileSync(path.join(dir, 'level.dat'), zlib.gzipSync(level));
}
module.exports = { makeWorld, chunkBytes, writeRegion };
