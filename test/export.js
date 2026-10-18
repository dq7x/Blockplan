const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const B = require('../src/core.js');

/* Befehle auf ein leeres Gitter anwenden, wie es Minecraft tun würde, und mit der Vorlage vergleichen */
function apply(cmds, size, org) {
  const [GX, GY, GZ] = size; const g = new Array(GX * GY * GZ).fill('minecraft:air'); let max = 0;
  for (const c of cmds) {
    const t = c.split(' ');
    if (t[0] === 'setblock') { const [x, y, z] = [+t[1] - org[0], +t[2] - org[1], +t[3] - org[2]]; g[x + z * GX + y * GX * GZ] = t[4]; max = Math.max(max, 1); }
    else if (t[0] === 'fill') {
      const a = [+t[1] - org[0], +t[2] - org[1], +t[3] - org[2]], b = [+t[4] - org[0], +t[5] - org[1], +t[6] - org[2]];
      const vol = (b[0] - a[0] + 1) * (b[1] - a[1] + 1) * (b[2] - a[2] + 1); assert.ok(vol <= 32768, 'Limit überschritten: ' + c); max = Math.max(max, vol);
      for (let y = a[1]; y <= b[1]; y++) for (let z = a[2]; z <= b[2]; z++) for (let x = a[0]; x <= b[0]; x++) g[x + z * GX + y * GX * GZ] = t[7];
    } else assert.fail('Unbekannter Befehl ' + c);
  }
  return { g, max };
}
const keyOf = (m, i) => (m.grid[i] ? m.palette[m.grid[i]].key : 'minecraft:air');

/* 1) Beispielburg komplett */
{
  const m = B.makeSample(), org = [-300, 70, 1000];
  const r = B.exportCommands(m, { origin: org });
  const sim = apply(r.commands, m.size, org);
  for (let i = 0; i < m.grid.length; i++) assert.strictEqual(sim.g[i], keyOf(m, i), 'Zelle ' + i);
  assert.strictEqual(r.stats.blocks, m.total);
  assert.ok(r.stats.total < m.total / 2, 'Zusammenfassung wirkt: ' + r.stats.total + ' Befehle für ' + m.total + ' Blöcke');
  /* Reihenfolge: erst volle Blöcke, dann Rest */
  const idxFirstNonCube = r.commands.findIndex((c) => /torch|door|stairs|slab|lantern|bed|pane|fence/.test(c));
  const idxLastCube = r.commands.map((c, i) => (/ minecraft:(stone_bricks|cobblestone|oak_planks|grass_block|spruce_planks|mossy_stone_bricks|stripped_oak_log|furnace|crafting_table|oak_log)(\[|$)/.test(c) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(idxFirstNonCube > idxLastCube, 'volle Blöcke vor Fackeln, Türen, Treppen');
  console.log('ok Export Burg: ' + r.stats.total + ' Befehle (' + r.stats.fill + ' fill, ' + r.stats.setblock + ' setblock) für ' + m.total + ' Blöcke, Simulation identisch');
}

/* 2) Limit 32768 bei einem großen Quader, Ebenenbereich und Statusfilter */
{
  const mb = new B.ModelBuilder(40, 40, 40);
  mb.fill(0, 0, 0, 39, 39, 39, 'minecraft:stone');
  const m = mb.finish({});
  const r = B.exportCommands(m, { origin: [0, 0, 0] });
  const sim = apply(r.commands, m.size, [0, 0, 0]);
  assert.ok(sim.g.every((v) => v === 'minecraft:stone'));
  assert.ok(sim.max <= 32768 && r.stats.blocks === 64000);
  assert.ok(r.stats.total >= 2 && r.stats.total <= 6, 'wenige große Quader: ' + r.stats.total);
  const part = B.exportCommands(m, { origin: [0, 0, 0], y0: 10, y1: 12 });
  assert.strictEqual(part.stats.blocks, 40 * 40 * 3);
  const status = new Uint8Array(m.grid.length).fill(1);
  status[5 + 5 * 40 + 5 * 1600] = 2; status[6 + 5 * 40 + 5 * 1600] = 3; status[7] = 5;
  const rest = B.exportCommands(m, { origin: [10, 20, 30], status });
  assert.strictEqual(rest.stats.blocks, 2);
  assert.deepStrictEqual(rest.commands, ['fill 15 25 35 16 25 35 minecraft:stone']);
  const clr = B.exportCommands(m, { origin: [0, 0, 0], status: new Uint8Array(m.grid.length), clear: true });
  assert.ok(clr.stats.clear >= 2 && clr.commands.every((c) => /minecraft:air$/.test(c)) && clr.stats.blocks === 0);
  const simc = apply(clr.commands, m.size, [0, 0, 0]); assert.ok(simc.max <= 32768);
  console.log('ok Export: Limit, Ebenenbereich, nur fehlend/falsch, Bereich leeren');
}

/* 3) Dateiaufteilung und Datapack */
{
  const lines = Array.from({ length: 70001 }, (_, i) => 'setblock ' + i + ' 0 0 minecraft:stone');
  const files = B.splitFiles(lines, 30000);
  assert.deepStrictEqual(files.map((f) => f.length), [30000, 30000, 10001]);
  const dp = B.buildDatapack(files, { description: 'Test' });
  assert.deepStrictEqual(Object.keys(dp), ['pack.mcmeta', 'data/blockplan/function/test.mcfunction', 'data/blockplan/function/build_001.mcfunction', 'data/blockplan/function/build_002.mcfunction', 'data/blockplan/function/build_003.mcfunction']);
  const mc = JSON.parse(dp['pack.mcmeta']); assert.strictEqual(mc.pack.min_format, 88); assert.strictEqual(mc.pack.max_format, 999);
  console.log('ok Dateiaufteilung (3 Dateien) und pack.mcmeta');
}

/* 4) ZIP-Writer gegen Python-zipfile prüfen */
{
  const files = { 'pack.mcmeta': '{"pack":{}}\n', 'data/blockplan/function/build_001.mcfunction': 'setblock 1 2 3 minecraft:stone\nÜber ß\n' };
  const zip = B.makeZip(files);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-zip-')), f = path.join(tmp, 't.zip');
  fs.writeFileSync(f, zip);
  const py = "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(sorted(z.namelist()));print(z.read('data/blockplan/function/build_001.mcfunction').decode('utf-8').splitlines()[1])";
  const out = cp.execFileSync('python3', ['-c', py, f]).toString();
  assert.ok(out.includes('build_001.mcfunction') && out.includes('Über ß'), out);
  console.log('ok ZIP vom Python-Leser geprüft');
}
console.log('\nExport-Tests bestanden.');

/* 5) Drehen */
{
  const R = B.rotateModel;
  const m = B.makeSample();
  const r4 = R(R(R(R(m, 1), 1), 1), 1);
  assert.deepStrictEqual(r4.size, m.size);
  for (let i = 0; i < m.grid.length; i++) assert.strictEqual(keyOf(r4, i), keyOf(m, i), 'vier Drehungen = Original');
  const r1 = R(m, 1), r3 = R(m, 3), r2 = R(m, 2);
  assert.deepStrictEqual(r1.size, [m.size[2], m.size[1], m.size[0]]);
  assert.strictEqual(r1.total, m.total);
  assert.deepStrictEqual(R(r1, 3).grid, m.grid.length ? R(m, 4).grid : null);
  assert.deepStrictEqual(R(r1, 1).grid, r2.grid); assert.deepStrictEqual(R(m, 3).size, r1.size);
  /* Einzelblock: Ecke NW (0,0) -> NE, Treppe facing north -> east */
  const mb = new B.ModelBuilder(3, 1, 2);
  mb.set(0, 0, 0, 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight]');
  mb.set(2, 0, 1, 'minecraft:oak_log[axis=x]');
  mb.set(1, 0, 0, 'minecraft:oak_fence[north=true,east=false,south=false,west=true]');
  mb.set(1, 0, 1, 'minecraft:rail[shape=ascending_north]');
  const a = mb.finish({}), b = R(a, 1);
  assert.deepStrictEqual(b.size, [2, 1, 3]);
  const at = (x, z) => b.palette[b.grid[x + z * 2]].key;
  assert.strictEqual(at(1, 0), 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight]');
  assert.strictEqual(at(0, 2), 'minecraft:oak_log[axis=z]');
  assert.strictEqual(at(1, 1), 'minecraft:oak_fence[east=true,north=true,south=false,west=false]');
  assert.strictEqual(at(0, 1), 'minecraft:rail[shape=ascending_east]');
  console.log('ok Drehen: 4x = Original, Position und Eigenschaften korrekt');
}

/* 6) Umbenennung und unbekannte Blöcke */
{
  assert.strictEqual(B.upgradeName('minecraft:chain', '26.3'), 'minecraft:iron_chain');
  assert.strictEqual(B.upgradeName('minecraft:chain', '1.21.8'), 'minecraft:chain');
  assert.strictEqual(B.upgradeName('minecraft:chain', '1.21.9'), 'minecraft:iron_chain');
  assert.strictEqual(B.upgradeName('minecraft:chain', null), 'minecraft:chain');
  const mb = new B.ModelBuilder(4, 1, 1);
  mb.set(0, 0, 0, 'minecraft:chain[axis=y]'); mb.set(1, 0, 0, 'minecraft:stone'); mb.set(2, 0, 0, 'minecraft:fantasy_block'); mb.set(3, 0, 0, 'minecraft:water[level=0]');
  const m = mb.finish({});
  const known = new Set(['minecraft:stone', 'minecraft:iron_chain']);
  const r = B.exportCommands(m, { origin: [0, 0, 0], gameVersion: '26.3', known });
  const txt = r.commands.join('\n');
  assert.ok(/iron_chain\[axis=y\]/.test(txt) && !/ minecraft:chain/.test(txt), txt);
  assert.ok(!/fantasy_block/.test(txt) && r.stats.skipped.join() === 'minecraft:fantasy_block', JSON.stringify(r.stats));
  const r0 = B.exportCommands(m, { origin: [0, 0, 0] });
  assert.ok(/ minecraft:chain\[axis=y\]/.test(r0.commands.join('\n')) && /fantasy_block/.test(r0.commands.join('\n')), 'ohne Version unverändert');
  console.log('ok Umbenennung chain -> iron_chain, unbekannte Blöcke übersprungen');
}
