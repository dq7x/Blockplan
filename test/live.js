let chromium; try { ({ chromium } = require('playwright')); } catch (e) { console.error('Für die UI-Tests: npm i -D playwright && npx playwright install chromium'); process.exit(2); }
const launchOpts = (extra) => Object.assign({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] }, process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}, extra);
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const B = require('../src/core.js');
const { makeWorld } = require('./world.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-live-'));
const saves = path.join(tmp, 'saves'); fs.mkdirSync(saves);
const wdir = path.join(saves, 'Meine Welt');
const model = B.makeSample();
const [GX, GY, GZ] = model.size;
const O = [100, 64, -50];
const keyAt = (lx, ly, lz) => { const e = model.palette[model.grid[lx + lz * GX + ly * GX * GZ]]; return e.air ? 'minecraft:air' : e.key; };
/* Welt: Bauplatz mit Stein darunter; Vorlage bis Ebene `upTo` gebaut, ein Block falsch */
function build(upTo, wrongAt) {
  const blockAt = (x, y, z) => {
    if (y < O[1]) return y < 60 ? 'minecraft:stone' : 'minecraft:dirt';
    const lx = x - O[0], ly = y - O[1], lz = z - O[2];
    if (lx < 0 || lz < 0 || lx >= GX || lz >= GZ || ly >= GY) return 'minecraft:air';
    if (ly >= upTo) return 'minecraft:air';
    if (wrongAt && lx === wrongAt[0] && ly === wrongAt[1] && lz === wrongAt[2]) return 'minecraft:gold_block';
    return keyAt(lx, ly, lz);
  };
  const chunks = [];
  for (let cz = Math.floor(O[2] / 16); cz <= Math.floor((O[2] + GZ - 1) / 16); cz++) for (let cx = Math.floor(O[0] / 16); cx <= Math.floor((O[0] + GX - 1) / 16); cx++) chunks.push([cx, cz]);
  makeWorld(wdir, blockAt, chunks, { name: 'Meine Welt', yMin: 0, yMax: 100 });
}
function expected(upTo, wrongAt) {
  let ok = 0, miss = 0, wrong = 0;
  for (let ly = 0; ly < GY; ly++) for (let lz = 0; lz < GZ; lz++) for (let lx = 0; lx < GX; lx++) {
    if (!model.grid[lx + lz * GX + ly * GX * GZ]) continue;
    if (ly >= upTo) miss++;
    else if (wrongAt && lx === wrongAt[0] && ly === wrongAt[1] && lz === wrongAt[2]) wrong++;
    else ok++;
  }
  return { ok, miss, wrong };
}

(async () => {
  build(8, [0, 1, 0]);
  const port = 8799;
  const srv = spawn('node', [path.resolve(__dirname, '../dist/blockplan-live/server.js'), '--saves', saves, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 50 && !/läuft/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(/läuft/.test(out), 'Server startet: ' + out);
  const browser = await chromium.launch(launchOpts());
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.goto('http://localhost:' + port + '/');
    await page.waitForTimeout(700);
    assert.ok(await page.locator('#livesec').isVisible(), 'Live-Bereich sichtbar');
    const opts = await page.locator('#world option').allInnerTexts();
    console.log('Welten:', JSON.stringify(opts));
    await page.selectOption('#world', 'Meine Welt');
    await page.waitForTimeout(500);
    /* Startpunkt setzen */
    await page.fill('#ox', String(O[0])); await page.fill('#oy', String(O[1])); await page.fill('#oz', String(O[2]));
    await page.waitForTimeout(1500);
    let st = await page.evaluate(() => __bp.LIVE.stats);
    let exp = expected(8, [0, 1, 0]);
    console.log('Stand 1:', JSON.stringify(st), 'erwartet', JSON.stringify(exp));
    assert.strictEqual(st.ok, exp.ok); assert.strictEqual(st.miss, exp.miss); assert.strictEqual(st.wrong, exp.wrong); assert.strictEqual(st.unk, 0);
    console.log('Statustext:', (await page.locator('#livestat').innerText()).replace(/\n+/g, ' | ').slice(0, 200));
    await page.screenshot({ path: 'dist/shot-live-3d.png' });
    /* Auswahl des falschen Blocks zeigt Live-Zeile */
    await page.evaluate(() => __bp.select({ x: 0, y: 1, z: 0 }));
    await page.waitForTimeout(150);
    console.log('Block-Pane:', (await page.locator('#pane').innerText()).replace(/\n+/g, ' | ').slice(0, 140));
    /* Plan-Ansicht Ebene 3 */
    await page.click('#v2d'); await page.evaluate(() => { __bp.setMode('only'); __bp.setLayer(1); });
    await page.waitForTimeout(250);
    await page.screenshot({ path: 'dist/shot-live-plan.png' });
    /* Material: fehlt noch */
    await page.click('#tb-mat'); await page.click('button[data-act="mat-rem"]'); await page.waitForTimeout(150);
    console.log('Fehlt-noch-Material, Zeilen:', await page.locator('#pane tr.pick').count(), '·', (await page.locator('#pane .tot').innerText()).replace(/\n+/g, ' '));
    await page.screenshot({ path: 'dist/shot-live-mat.png' });
    /* Ebenen */
    await page.click('#tb-layer'); await page.waitForTimeout(100);
    const doneLayers = await page.locator('#pane tr.done').count();
    console.log('Ebenen automatisch fertig:', doneLayers);
    /* Welt ändert sich: bis Ebene 12 gebaut, falscher Block korrigiert */
    await new Promise((r) => setTimeout(r, 40));
    build(12, null);
    await page.evaluate(() => __bp.livePoll(false));
    await page.waitForTimeout(800);
    st = await page.evaluate(() => __bp.LIVE.stats); exp = expected(12, null);
    console.log('Stand 2:', JSON.stringify(st), 'erwartet', JSON.stringify(exp));
    assert.strictEqual(st.ok, exp.ok); assert.strictEqual(st.miss, exp.miss); assert.strictEqual(st.wrong, 0);
    /* Eigenschaften-Vergleich aus: falsche Treppenrichtung zählt dann als ok */
    await page.uncheck('#livestrict'); await page.waitForTimeout(300);
    const st2 = await page.evaluate(() => __bp.LIVE.stats);
    console.log('ohne Ausrichtung:', JSON.stringify(st2));
    await page.click('#v3d'); await page.waitForTimeout(400);
    await page.evaluate(() => __bp.setMode('all'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'dist/shot-live-3d-b.png' });
    /* Befehle-Tab: nur fehlend/falsch (Stand 2: Ebenen >= 12 fehlen) */
    await page.evaluate(() => __bp.setMode('all'));
    await page.click('#tb-cmd'); await page.waitForTimeout(150);
    await page.click('button[data-cmd="content"][data-val="miss"]'); await page.waitForTimeout(150);
    const cmdsMiss = await page.evaluate(() => (document.querySelector('.cmdprev') || {}).textContent);
    const exp2 = expected(12, null);
    const total = await page.locator('#pane p b').first().innerText();
    console.log('Befehle (nur fehlend):', total, 'Befehle, erste Zeile:', cmdsMiss.split('\n')[0]);
    const fx = await page.evaluate(() => __bp.S.model && document.querySelector('#pane').innerText.match(/für ([\d.]+) Blöcke/)[1]);
    assert.strictEqual(+fx.replace(/\./g, ''), exp2.miss, 'Befehle decken genau die fehlenden Blöcke ab');
    await page.screenshot({ path: 'dist/shot-cmd.png' });
    /* In Welt schreiben */
    await page.click('button[data-cmd-act="write"]'); await page.waitForTimeout(500);
    const dpDir = path.join(wdir, 'datapacks', 'blockplan');
    assert.ok(fs.existsSync(path.join(dpDir, 'pack.mcmeta')), 'pack.mcmeta geschrieben');
    assert.ok(fs.existsSync(path.join(dpDir, 'data/blockplan/function/build_001.mcfunction')), 'Funktion geschrieben');
    const mc = fs.readFileSync(path.join(dpDir, 'data/blockplan/function/build_001.mcfunction'), 'utf8');
    assert.ok(/^fill 1\d\d |^setblock 1\d\d /m.test(mc) && !/^\//m.test(mc), 'Befehle mit absoluten Koordinaten, ohne Schrägstrich');
    /* Endpoint verweigert unzulässige Dateinamen und fremde Origins */
    const bad = await page.evaluate(async () => (await fetch('/api/datapack', { method: 'POST', body: JSON.stringify({ files: { '../../evil.txt': 'x' } }) })).status);
    assert.strictEqual(bad, 400);
    const foreign = await new Promise((resolve) => { const rq = require('http').request({ host: '127.0.0.1', port, path: '/api/datapack', method: 'POST', headers: { Host: 'evil.example', 'Content-Type': 'application/json' } }, (rs) => resolve(rs.statusCode)); rq.end('{"files":{}}'); });
    assert.strictEqual(foreign, 403);
    assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')));
    console.log('Datapack-Schreiben und Schutz ok');
    /* Welt-Umgebung: laden, verschieben, Klick setzt Startpunkt */
    await page.check('#envon'); await page.waitForTimeout(2500);
    const env = await page.evaluate(() => ({ has: !!__bp.ENV.model, size: __bp.ENV.model && __bp.ENV.model.size, x0: __bp.ENV.x0, y0: __bp.ENV.y0, z0: __bp.ENV.z0, err: __bp.ENV.err, pos: __bp.ENV.op && [__bp.ENV.op.position.x, __bp.ENV.op.position.y, __bp.ENV.op.position.z] }));
    console.log('Umgebung:', JSON.stringify(env));
    assert.ok(env.has && !env.err, 'Umgebung geladen');
    assert.deepStrictEqual(env.pos, [env.x0 - O[0], env.y0 - O[1], env.z0 - O[2]]);
    await page.screenshot({ path: 'dist/shot-env.png' });
    await page.evaluate(() => __bp.nudgeOrigin(5, 0, -3));
    const pos2 = await page.evaluate(() => [__bp.ENV.op.position.x, __bp.ENV.op.position.z, __bp.S.origin.join(',')]);
    assert.deepStrictEqual(pos2.slice(0, 2), [env.pos[0] - 5, env.pos[2] + 3]);
    await page.evaluate(() => __bp.nudgeOrigin(-5, 0, 3));
    /* Klick auf den Boden setzt den Startpunkt (Boden = Erde bis Y 63, Vorlage landet auf Y 64) */
    await page.check('#envpick');
    await page.mouse.click(60, 600); await page.waitForTimeout(300);
    const org2 = await page.evaluate(() => __bp.S.origin.slice());
    console.log('Startpunkt nach Klick:', JSON.stringify(org2));
    assert.ok(org2[0] !== O[0] || org2[2] !== O[2], 'Startpunkt hat sich bewegt');
    assert.strictEqual(org2[1], 64, 'Vorlage steht auf dem Boden');
    assert.strictEqual(await page.inputValue('#ox'), String(org2[0]));
    await page.screenshot({ path: 'dist/shot-env2.png' });
    /* Fehler: Dimension ohne Daten */
    const r = await page.evaluate(async () => (await fetch('/api/box?dim=nether&x=0&y=0&z=0&sx=2&sy=2&sz=2')).json());
    console.log('Nether-Abfrage:', JSON.stringify(r));
    /* Path-Traversal-Schutz */
    const t = await page.evaluate(async () => (await fetch('/api/select?name=' + encodeURIComponent('../..'))).status);
    console.log('select ../.. →', t);
    assert.ok(t === 404);
    console.log(errors.length ? 'FEHLER:\n' + errors.join('\n') : 'Keine Konsolenfehler');
  } finally { await browser.close(); srv.kill(); }
})().catch((e) => { console.error('Live-Test fehlgeschlagen:', e); process.exit(1); });
