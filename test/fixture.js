/* Schreibt das Beispielmodell als echte .litematic (gzip) und als .schem (Sponge v2) für den Browser-Test. */
const zlib = require('zlib');
const fs = require('fs');
const B = require('../src/core.js');
const m = B.makeSample();
const w = () => { const parts = []; return {
  u8: (v) => { const b = Buffer.alloc(1); b.writeUInt8(v & 255); parts.push(b); },
  i16: (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v); parts.push(b); },
  i32: (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); parts.push(b); },
  i64: (v) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt.asIntN(64, v)); parts.push(b); },
  str: (s) => { const e = Buffer.from(s); const l = Buffer.alloc(2); l.writeUInt16BE(e.length); parts.push(l, e); },
  raw: (b) => parts.push(Buffer.from(b)), done: () => Buffer.concat(parts) }; };
const T = { short: 2, int: 3, str: 8, list: 9, comp: 10, bytes: 7, longs: 12 };
function pay(o, t, v) {
  if (t === T.short) o.i16(v); else if (t === T.int) o.i32(v); else if (t === T.str) o.str(v);
  else if (t === T.bytes) { o.i32(v.length); o.raw(v); }
  else if (t === T.longs) { o.i32(v.length); v.forEach((x) => o.i64(x)); }
  else if (t === T.list) { o.u8(v.type); o.i32(v.items.length); v.items.forEach((x) => pay(o, v.type, x)); }
  else { for (const [k, [tt, val]] of Object.entries(v)) { o.u8(tt); o.str(k); pay(o, tt, val); } o.u8(0); }
}
const nbt = (name, c) => { const o = w(); o.u8(10); o.str(name); pay(o, T.comp, c); return o.done(); };
const I = (v) => [T.int, v], S = (v) => [T.str, v], C = (v) => [T.comp, v];
const [GX, GY, GZ] = m.size;
const bits = Math.max(2, Math.ceil(Math.log2(m.palette.length)));
const total = GX * GY * GZ, nl = Math.ceil(total * bits / 64);
const longs = new Array(nl).fill(0n);
for (let i = 0; i < total; i++) {
  const v = BigInt(m.grid[i]), bit = BigInt(i * bits), li = Number(bit / 64n), off = bit % 64n;
  longs[li] |= (v << off) & 0xFFFFFFFFFFFFFFFFn;
  if (off + BigInt(bits) > 64n) longs[li + 1] |= v >> (64n - off);
}
const lit = nbt('', { Metadata: C({ Name: S('Fixture Burg'), Author: S('Test') }), MinecraftDataVersion: I(3955), Version: I(6), Regions: C({ main: C({
  Position: C({ x: I(0), y: I(0), z: I(0) }), Size: C({ x: I(GX), y: I(GY), z: I(GZ) }),
  BlockStatePalette: [T.list, { type: T.comp, items: m.palette.map((e) => { const o = { Name: S(e.name) }; const ks = Object.keys(e.props || {}); if (ks.length) o.Properties = C(Object.fromEntries(ks.map((k) => [k, S(e.props[k])]))); return o; }) }],
  BlockStates: [T.longs, longs.map((x) => BigInt.asIntN(64, x))] }) }) });
fs.writeFileSync('dist/fixture.litematic', zlib.gzipSync(lit));
console.log('fixture ok', m.total, 'Blöcke, Palette', m.palette.length);
