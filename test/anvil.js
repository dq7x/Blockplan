const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const A = require('../server/anvil.js');
const { makeWorld } = require('./world.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-world-'));
const world = path.join(tmp, 'Testwelt');

/* Boden Stein bis y=0, Gras y=1, einige Marker; Chunks über Regionsgrenze 0/-1 hinweg */
const blockAt = (x, y, z) => {
  if (y < -10) return 'minecraft:bedrock';
  if (y <= 0) return 'minecraft:stone';
  if (y === 1) return 'minecraft:grass_block[snowy=false]';
  if (x === 5 && y === 2 && z === 5) return 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]';
  if (x === -1 && y === 2 && z === -1) return 'minecraft:gold_block';
  if (x === 31 && y === 40 && z === 17) return 'minecraft:diamond_block';
  if (x === 16 && y === 3 && z === 0) return 'minecraft:cave_air';
  return 'minecraft:air';
};
const chunks = [[0, 0], [1, 0], [0, 1], [1, 1], [-1, -1], [-1, 0], [0, -1]];
makeWorld(world, blockAt, chunks, { name: 'Testwelt' });

const dims = A.findDims(world);
assert.deepStrictEqual(Object.keys(dims), ['overworld']);
const lv = A.readLevel(world);
assert.strictEqual(lv.name, 'Testwelt'); assert.strictEqual(lv.version, '26.3');
assert.deepStrictEqual(lv.player, { x: 10, y: 70, z: -21, dim: 'minecraft:overworld' });

/* Quader über Chunk- und Regionsgrenzen, mit negativen Koordinaten und y über mehrere Abschnitte */
const x0 = -4, y0 = -12, z0 = -4, sx = 40, sy = 60, sz = 24;
const r = A.readBox(dims.overworld, x0, y0, z0, sx, sy, sz);
let checked = 0, unknown = 0;
for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
  const wx = x0 + x, wy = y0 + y, wz = z0 + z;
  const g = r.grid[x + z * sx + y * sx * sz];
  const cx = Math.floor(wx / 16), cz = Math.floor(wz / 16);
  const have = chunks.some(([a, b]) => a === cx && b === cz);
  if (!have) { assert.strictEqual(g, A.UNKNOWN, 'nicht gespeicherter Chunk @' + [wx, wy, wz]); unknown++; continue; }
  const want = blockAt(wx, wy, wz);
  const e = r.palette[g];
  const key = e.name + (Object.keys(e.props).length ? '[' + Object.keys(e.props).sort().map((k) => k + '=' + e.props[k]).join(',') + ']' : '');
  const wantNorm = want === 'minecraft:cave_air' ? 'minecraft:air' : want.replace(/\[(.*)\]/, (m, p) => '[' + p.split(',').sort().join(',') + ']');
  assert.strictEqual(key, wantNorm, 'Block @' + [wx, wy, wz] + ' ' + key + ' != ' + wantNorm);
  checked++;
}
assert.strictEqual(r.unknown, unknown, 'unknown-Zähler');
assert.ok(checked > 10000 && unknown > 0, 'beide Fälle geprüft: ' + checked + ' / ' + unknown);
console.log('ok Anvil: ' + checked + ' Blöcke exakt, ' + unknown + ' Zellen in fehlenden Chunks, Regionen 0/-1');

/* Signatur ändert sich, wenn die Datei geändert wird */
const s1 = A.boxSignature(dims.overworld, 0, 0, 16, 16).sig;
const blockAt2 = (x, y, z) => (x === 3 && y === 5 && z === 3 ? 'minecraft:emerald_block' : blockAt(x, y, z));
setTimeout(() => {
  makeWorld(world, blockAt2, chunks, { name: 'Testwelt' });
  const s2 = A.boxSignature(dims.overworld, 0, 0, 16, 16).sig;
  assert.notStrictEqual(s1, s2, 'Signatur ändert sich');
  const r2 = A.readBox(dims.overworld, 0, 0, 0, 16, 8, 16);
  const e = r2.palette[r2.grid[3 + 3 * 16 + 5 * 256]];
  assert.strictEqual(e.name, 'minecraft:emerald_block', 'Cache wird bei Dateiänderung verworfen');
  console.log('ok Änderungserkennung und Cache-Invalidierung');
  /* Dimension-Ordner-Varianten */
  const w2 = path.join(tmp, 'Neu'); fs.mkdirSync(path.join(w2, 'dimensions/minecraft/overworld'), { recursive: true });
  makeWorld(path.join(tmp, 'tmpw'), blockAt, [[0, 0]], { name: 'x' });
  fs.renameSync(path.join(tmp, 'tmpw', 'region'), path.join(w2, 'dimensions/minecraft/overworld/region'));
  assert.ok(A.findDims(w2).overworld, 'neues Ordnerlayout gefunden');
  console.log('ok Ordnerlayout dimensions/minecraft/overworld');
  console.log('\nAnvil-Tests bestanden.');
}, 30);
