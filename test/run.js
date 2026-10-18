/* Tests für core.js: Encoder bauen Testdateien unabhängig (BigInt/zlib), Parser müssen sie zurücklesen. */
const zlib = require('zlib');
const assert = require('assert');
const B = require('../src/core.js');

/* ---------- minimaler NBT-Writer ---------- */
const T = { byte: 1, short: 2, int: 3, long: 4, bytes: 7, str: 8, list: 9, comp: 10, ints: 11, longs: 12 };
function w() {
  const parts = [];
  const api = {
    u8: (v) => { const b = Buffer.alloc(1); b.writeUInt8(v & 255); parts.push(b); },
    i16: (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v); parts.push(b); },
    i32: (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); parts.push(b); },
    i64: (v) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt.asIntN(64, BigInt(v))); parts.push(b); },
    str: (s) => { const e = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(e.length); parts.push(l, e); },
    raw: (b) => parts.push(Buffer.from(b)),
    done: () => Buffer.concat(parts),
  };
  return api;
}
function writePayload(o, type, v) {
  switch (type) {
    case T.byte: o.u8(v); break;
    case T.short: o.i16(v); break;
    case T.int: o.i32(v); break;
    case T.long: o.i64(v); break;
    case T.str: o.str(v); break;
    case T.bytes: o.i32(v.length); o.raw(v); break;
    case T.ints: o.i32(v.length); v.forEach((x) => o.i32(x)); break;
    case T.longs: o.i32(v.length); v.forEach((x) => o.i64(x)); break;
    case T.list: o.u8(v.type); o.i32(v.items.length); v.items.forEach((x) => writePayload(o, v.type, x)); break;
    case T.comp:
      for (const [k, [t, val]] of Object.entries(v)) { o.u8(t); o.str(k); writePayload(o, t, val); }
      o.u8(0); break;
  }
}
function nbt(rootName, comp) { const o = w(); o.u8(10); o.str(rootName); writePayload(o, T.comp, comp); return o.done(); }
const I = (v) => [T.int, v];
const S = (v) => [T.str, v];
const C = (v) => [T.comp, v];
const L = (type, items) => [T.list, { type, items }];

/* Testmodell: 5 x 3 x 4 mit Palette aus 6 Zuständen */
const SX = 5, SY = 3, SZ = 4;
const states = [
  { n: 'minecraft:air', p: {} },
  { n: 'minecraft:stone', p: {} },
  { n: 'minecraft:oak_stairs', p: { facing: 'north', half: 'bottom' } },
  { n: 'minecraft:glass', p: {} },
  { n: 'minecraft:oak_slab', p: { type: 'double' } },
  { n: 'minecraft:red_wool', p: {} },
];
const truth = [];
for (let y = 0; y < SY; y++) for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
  truth.push(((x * 3 + y * 5 + z * 7) % 11) % 6);
}
const keyAt = (i) => { const s = states[truth[i]]; return B.stateKey(s.n, s.p); };

function litematic(regions) {
  const regs = {};
  for (const r of regions) {
    const bits = Math.max(2, Math.ceil(Math.log2(r.palette.length)));
    const total = Math.abs(r.size[0] * r.size[1] * r.size[2]);
    const nLongs = Math.ceil(total * bits / 64);
    const longs = new Array(nLongs).fill(0n);
    for (let i = 0; i < total; i++) {
      const v = BigInt(r.values[i]);
      const bit = BigInt(i * bits);
      const li = Number(bit / 64n), off = bit % 64n;
      longs[li] |= (v << off) & 0xFFFFFFFFFFFFFFFFn;
      if (off + BigInt(bits) > 64n) longs[li + 1] |= v >> (64n - off);
    }
    regs[r.name] = C({
      Position: C({ x: I(r.pos[0]), y: I(r.pos[1]), z: I(r.pos[2]) }),
      Size: C({ x: I(r.size[0]), y: I(r.size[1]), z: I(r.size[2]) }),
      BlockStatePalette: L(T.comp, r.palette.map((s) => {
        const o = { Name: S(s.n) };
        if (Object.keys(s.p).length) o.Properties = C(Object.fromEntries(Object.entries(s.p).map(([k, v]) => [k, S(v)])));
        return o;
      })),
      BlockStates: [T.longs, longs.map((x) => BigInt.asIntN(64, x))],
    });
  }
  return nbt('', {
    Metadata: C({ Name: S('Testburg'), Author: S('Tester') }),
    MinecraftDataVersion: I(3955), Version: I(6),
    Regions: C(regs),
  });
}
const gz = (b) => zlib.gzipSync(b);
const gunz = (b) => new Uint8Array(zlib.gunzipSync(b));

function checkModel(m, label, offset) {
  offset = offset || [0, 0, 0];
  assert.deepStrictEqual(m.size, [SX, SY, SZ], label + ' size');
  for (let y = 0; y < SY; y++) for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
    const t = states[truth[x + z * SX + y * SX * SZ]];
    const got = m.palette[m.grid[x + z * SX + y * SX * SZ]];
    const want = B.stateKey(t.n, t.p);
    assert.strictEqual(got.key, want, label + ' @' + [x, y, z] + ' ' + got.key + ' != ' + want);
  }
}

/* 1) Litematic, eine Region (bits=3, Werte überspannen Longs) */
{
  const bytes = gunz(gz(litematic([{ name: 'a', pos: [0, 0, 0], size: [SX, SY, SZ], palette: states, values: truth }])));
  const m = B.parseSchematic(bytes);
  checkModel(m, 'litematic');
  assert.strictEqual(m.name, 'Testburg');
  const air = truth.filter((v) => v === 0).length;
  assert.strictEqual(m.total, truth.length - air, 'total');
  console.log('ok litematic (1 Region, 3 Bit, Long-Überlauf)');
}

/* 2) Litematic mit negativer Größe und zwei Regionen */
{
  /* Region A: links, normale Größe. Region B: rechts, negative Größe (x:-2) ab Position x=5 */
  const pa = states.slice(0, 3), pb = [states[0], states[5]];
  const A = { name: 'A', pos: [0, 0, 0], size: [3, 1, 2], palette: pa, values: [1, 2, 1, 2, 1, 2] };
  const Bm = { name: 'B', pos: [4, 0, 0], size: [-2, 1, 2], palette: pb, values: [1, 1, 1, 0] };
  const m = B.parseSchematic(gunz(gz(litematic([A, Bm]))));
  assert.deepStrictEqual(m.size, [5, 1, 2], 'multi size ' + m.size);
  /* B belegt x=3..4 (pos 4 + (-2+1) = 3). Indizes (x fastest): (3,0)=1,(4,0)=1,(3,1)=1,(4,1)=0 */
  const k = (x, z) => m.palette[m.grid[x + z * 5]].key;
  assert.strictEqual(k(0, 0), 'minecraft:stone');
  assert.strictEqual(k(1, 0), 'minecraft:oak_stairs[facing=north,half=bottom]');
  assert.strictEqual(k(2, 1), 'minecraft:oak_stairs[facing=north,half=bottom]');
  assert.strictEqual(k(3, 0), 'minecraft:red_wool');
  assert.strictEqual(k(4, 0), 'minecraft:red_wool');
  assert.strictEqual(k(3, 1), 'minecraft:red_wool');
  assert.strictEqual(k(4, 1), 'minecraft:air');
  console.log('ok litematic (2 Regionen, negative Größe)');
}

/* 3) Sponge v2 mit Varint (Palette > 128 Einträge) */
{
  const W = 6, H = 2, Ln = 5;
  const pal = {};
  pal['minecraft:air'] = 0;
  const N = 150;
  for (let i = 1; i < N; i++) pal['minecraft:test_block_' + i] = i;
  pal['minecraft:oak_stairs[facing=east,half=top]'] = N;
  const vals = [];
  for (let i = 0; i < W * H * Ln; i++) vals.push((i * 37) % (N + 1));
  const data = [];
  for (const v0 of vals) { let v = v0; for (;;) { if (v < 128) { data.push(v); break; } data.push((v & 127) | 128); v >>= 7; } }
  const buf = nbt('Schematic', {
    Version: I(2), DataVersion: I(3700), Width: [T.short, W], Height: [T.short, H], Length: [T.short, Ln],
    PaletteMax: I(N + 1),
    Palette: C(Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, I(v)]))),
    BlockData: [T.bytes, Buffer.from(data)],
  });
  const m = B.parseSchematic(gunz(gz(buf)));
  assert.deepStrictEqual(m.size, [W, H, Ln]);
  const inv = Object.fromEntries(Object.entries(pal).map(([k, v]) => [v, k]));
  for (let i = 0; i < vals.length; i++) {
    const want = vals[i] === 0 ? 'minecraft:air' : B.stateKey(B.parseState(inv[vals[i]]).name, B.parseState(inv[vals[i]]).props);
    assert.strictEqual(m.palette[m.grid[i]].key, want, 'sponge v2 @' + i);
  }
  console.log('ok sponge v2 (Varint, ' + (N + 1) + ' Paletteneinträge)');
}

/* 4) Sponge v3 (Wurzel Schematic > Blocks) */
{
  const buf = nbt('', {
    Schematic: C({
      Version: I(3), DataVersion: I(4000), Width: [T.short, 2], Height: [T.short, 1], Length: [T.short, 2],
      Blocks: C({ Palette: C({ 'minecraft:air': I(0), 'minecraft:stone': I(1), 'minecraft:oak_log[axis=y]': I(2) }), Data: [T.bytes, Buffer.from([1, 2, 0, 1])] }),
    }),
  });
  const m = B.parseSchematic(new Uint8Array(buf));
  assert.deepStrictEqual(m.size, [2, 1, 2]);
  assert.strictEqual(m.palette[m.grid[1]].key, 'minecraft:oak_log[axis=y]');
  assert.strictEqual(m.total, 3);
  console.log('ok sponge v3');
}

/* 5) Vanilla structure .nbt */
{
  const buf = nbt('', {
    DataVersion: I(3700),
    size: L(T.int, [3, 2, 2]),
    palette: L(T.comp, [{ Name: S('minecraft:stone') }, { Name: S('minecraft:oak_stairs'), Properties: C({ facing: S('west'), half: S('top') }) }]),
    blocks: L(T.comp, [
      { pos: L(T.int, [0, 0, 0]), state: I(0) },
      { pos: L(T.int, [2, 1, 1]), state: I(1) },
    ]),
  });
  const m = B.parseSchematic(gunz(gz(buf)));
  assert.deepStrictEqual(m.size, [3, 2, 2]);
  assert.strictEqual(m.palette[m.grid[0]].key, 'minecraft:stone');
  assert.strictEqual(m.palette[m.grid[2 + 1 * 3 + 1 * 6]].key, 'minecraft:oak_stairs[facing=west,half=top]');
  assert.strictEqual(m.total, 2);
  console.log('ok structure .nbt');
}

/* 6) Fehlerfälle */
{
  assert.throws(() => B.parseSchematic(new Uint8Array([1, 2, 3, 4])), /NBT/);
  const legacy = nbt('Schematic', { Width: [T.short, 1], Height: [T.short, 1], Length: [T.short, 1], Materials: S('Alpha'), Blocks: [T.bytes, Buffer.from([1])], Data: [T.bytes, Buffer.from([0])] });
  assert.throws(() => B.parseSchematic(new Uint8Array(legacy)), /MCEdit/);
  console.log('ok Fehlerfälle');
}

/* 7) Mesh: 2x2x2-Würfel hat 24 sichtbare Quads, Hohlraum innen entfällt */
{
  const mb = new B.ModelBuilder(4, 4, 4);
  mb.fill(1, 1, 1, 2, 2, 2, 'minecraft:stone');
  const m = mb.finish({});
  const me = B.buildMesh(m);
  assert.strictEqual(me.opaque.n, 24, 'Würfel-Quads ' + me.opaque.n);
  assert.strictEqual(me.startsOpaque[4], 24);
  assert.strictEqual(me.startsOpaque[1], 0);
  assert.strictEqual(me.startsOpaque[2], 12, 'Quads bis Ebene 1 (ohne Ebene 2): ' + me.startsOpaque[2]);

  const mb2 = new B.ModelBuilder(3, 3, 3);
  mb2.fill(0, 0, 0, 2, 2, 2, 'minecraft:stone');
  mb2.set(1, 1, 1, 'minecraft:air');
  const me2 = B.buildMesh(mb2.finish({}));
  assert.strictEqual(me2.opaque.n, 54 + 6, 'Hohlwürfel: 54 außen + 6 innen = ' + me2.opaque.n);

  const mb3 = new B.ModelBuilder(3, 1, 1);
  mb3.fill(0, 0, 0, 2, 0, 0, 'minecraft:glass');
  const me3 = B.buildMesh(mb3.finish({}));
  assert.strictEqual(me3.glass.n, 2 * 4 + 2 * 3 + 0 + 0, 'Glasreihe (innere Flächen entfallen): ' + me3.glass.n);
  console.log('ok Mesh-Culling, Ebenenindex, Glas-Pass');
}

/* 8) Picking */
{
  const mb = new B.ModelBuilder(5, 5, 5);
  mb.set(2, 1, 2, 'minecraft:stone');
  mb.set(2, 3, 2, 'minecraft:gold_block');
  const m = mb.finish({});
  B.prepare(m.palette);
  let h = B.raycast(m, [2.5, 10, 2.5], [0, -1, 0], 0, 4);
  assert.deepStrictEqual([h.x, h.y, h.z], [2, 3, 2]);
  assert.deepStrictEqual(h.face, [0, 1, 0]);
  h = B.raycast(m, [2.5, 10, 2.5], [0, -1, 0], 0, 2);
  assert.deepStrictEqual([h.x, h.y, h.z], [2, 1, 2], 'Ebenenlimit blendet die obere aus');
  h = B.raycast(m, [-3, 1.5, 2.5], [1, 0, 0], 0, 4);
  assert.deepStrictEqual([h.x, h.y, h.z], [2, 1, 2]);
  assert.deepStrictEqual(h.face, [-1, 0, 0]);
  /* schräger Strahl */
  h = B.raycast(m, [0, 5, 0], [2.5 - 0, 3.5 - 5, 2.5 - 0], 0, 4);
  assert.deepStrictEqual([h.x, h.y, h.z], [2, 3, 2]);
  assert.strictEqual(B.raycast(m, [0.5, 10, 0.5], [0, -1, 0], 0, 4), null);
  console.log('ok Picking (DDA)');
}

/* 9) Materialliste */
{
  const mb = new B.ModelBuilder(4, 4, 4);
  mb.fill(0, 0, 0, 1, 0, 1, 'minecraft:stone');
  mb.set(2, 0, 0, 'minecraft:oak_slab[type=double]');
  mb.set(3, 0, 0, 'minecraft:oak_slab[type=bottom]');
  mb.set(0, 1, 0, 'minecraft:oak_door[facing=north,half=lower,hinge=left,open=false]');
  mb.set(0, 2, 0, 'minecraft:oak_door[facing=north,half=upper,hinge=left,open=false]');
  mb.set(1, 1, 0, 'minecraft:wall_torch[facing=east]');
  mb.set(1, 1, 1, 'minecraft:water[level=0]');
  mb.set(2, 1, 1, 'minecraft:red_bed[facing=north,part=foot]');
  mb.set(3, 1, 1, 'minecraft:red_bed[facing=north,part=head]');
  const list = B.materials(mb.finish({}));
  const g = Object.fromEntries(list.map((x) => [x.item, x.count]));
  assert.strictEqual(g['minecraft:stone'], 4);
  assert.strictEqual(g['minecraft:oak_slab'], 3, 'double slab zählt 2');
  assert.strictEqual(g['minecraft:oak_door'], 1, 'nur untere Türhälfte');
  assert.strictEqual(g['minecraft:torch'], 1);
  assert.strictEqual(g['minecraft:red_bed'], 1);
  assert.ok(!('minecraft:water' in g));
  assert.strictEqual(B.stackSize('minecraft:red_bed'), 1);
  console.log('ok Materialliste (Slabs, Türen, Betten, Wasser)');
}

/* 10) Beispielmodell und Farben */
{
  const m = B.makeSample();
  assert.ok(m.total > 1500, 'Beispiel hat Blöcke: ' + m.total);
  const me = B.buildMesh(m);
  assert.ok(me.opaque.n > 500);
  assert.ok(me.glass.n > 0);
  const mats = B.materials(m);
  assert.ok(mats.length > 15);
  for (const n of ['minecraft:stone_bricks', 'minecraft:red_wool', 'minecraft:oak_planks', 'minecraft:dark_oak_door', 'minecraft:xyz_unknown']) {
    const c = B.baseColor(n);
    assert.ok(c.length === 3 && c.every((v) => v >= 0 && v <= 255), n);
  }
  assert.deepStrictEqual(B.baseColor('minecraft:red_wool'), [161, 39, 34]);
  console.log('ok Beispiel: ' + m.size.join('x') + ', ' + m.total + ' Blöcke, ' + me.opaque.n + ' + ' + me.glass.n + ' Quads, ' + mats.length + ' Materialien');
}

/* 11) Leistung: 200 x 60 x 200 */
{
  const t0 = Date.now();
  const mb = new B.ModelBuilder(200, 60, 200);
  for (let y = 0; y < 30; y++) mb.fill(0, y, 0, 199, y, 199, 'minecraft:stone');
  for (let x = 0; x < 200; x += 2) for (let z = 0; z < 200; z += 2) mb.set(x, 30, z, 'minecraft:oak_planks');
  const m = mb.finish({});
  const me = B.buildMesh(m);
  console.log('ok Leistung: ' + m.total + ' Blöcke → ' + me.opaque.n + ' Quads in ' + (Date.now() - t0) + ' ms');
}
console.log('\nAlle Tests bestanden.');
