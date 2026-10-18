/* Minimaler NBT-Writer für Tests. */
const T = { byte: 1, short: 2, int: 3, long: 4, double: 6, bytes: 7, str: 8, list: 9, comp: 10, ints: 11, longs: 12 };
function w() {
  const parts = [];
  return {
    u8: (v) => { const b = Buffer.alloc(1); b.writeUInt8(v & 255); parts.push(b); },
    i16: (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v); parts.push(b); },
    i32: (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); parts.push(b); },
    i64: (v) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt.asIntN(64, BigInt(v))); parts.push(b); },
    f64: (v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); parts.push(b); },
    str: (s) => { const e = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(e.length); parts.push(l, e); },
    raw: (b) => parts.push(Buffer.from(b)),
    done: () => Buffer.concat(parts),
  };
}
function pay(o, t, v) {
  switch (t) {
    case T.byte: o.u8(v); break;
    case T.short: o.i16(v); break;
    case T.int: o.i32(v); break;
    case T.long: o.i64(v); break;
    case T.double: o.f64(v); break;
    case T.str: o.str(v); break;
    case T.bytes: o.i32(v.length); o.raw(v); break;
    case T.ints: o.i32(v.length); v.forEach((x) => o.i32(x)); break;
    case T.longs: o.i32(v.length); v.forEach((x) => o.i64(x)); break;
    case T.list: o.u8(v.type); o.i32(v.items.length); v.items.forEach((x) => pay(o, v.type, x)); break;
    case T.comp: for (const [k, [tt, val]] of Object.entries(v)) { o.u8(tt); o.str(k); pay(o, tt, val); } o.u8(0); break;
  }
}
const nbt = (name, comp) => { const o = w(); o.u8(10); o.str(name); pay(o, T.comp, comp); return o.done(); };
module.exports = { T, nbt, I: (v) => [T.int, v], S: (v) => [T.str, v], C: (v) => [T.comp, v], L: (type, items) => [T.list, { type, items }], BY: (v) => [T.byte, v], D: (v) => [T.double, v] };
