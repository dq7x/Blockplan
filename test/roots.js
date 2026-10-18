const { spawn } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), http = require('http');
const { makeWorld } = require('./world.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-home-'));
const saves = path.join(home, '.local/share/ModrinthApp/profiles/New instance (1)/saves');
const mk = (n) => makeWorld(path.join(saves, n), () => 'minecraft:stone', [[0, 0]], { name: n, yMin: 0, yMax: 32 });
mk('Neue Welt'); mk('Zweite Welt');
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ s: r.statusCode, j: JSON.parse(b) })); }).on('error', rej));
(async () => {
  const srv = spawn('node', ['dist/blockplan-live/server.js', '--port', '8801'], { env: Object.assign({}, process.env, { HOME: home, APPDATA: '' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', (d) => (out += d)); srv.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 50 && !/läuft/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  try {
    const info = (await get(8801, '/api/info')).j;
    console.log(out.split('\n').find((l) => /Saves/.test(l)));
    console.log(info.worlds.map((w) => w.name + ' => ' + w.label));
    assert.strictEqual(info.worlds.length, 2);
    assert.ok(/Modrinth: New instance \(1\)\/(Neue|Zweite) Welt/.test(info.worlds[0].name));
    const sel = await get(8801, '/api/select?name=' + encodeURIComponent(info.worlds[0].name));
    assert.strictEqual(sel.s, 200);
    const bad = await get(8801, '/api/select?name=' + encodeURIComponent('Modrinth: New instance (1)/../..'));
    assert.strictEqual(bad.s, 404);
    const logs = path.join(saves, '..', 'logs'); fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, 'latest.log'), '[18:00:00] [Server thread/INFO]: hallo\n[18:00:01] [Server thread/ERROR]: Failed to load function blockplan:build_001: Unknown block type foo at position 12\n');
    const lg = await get(8801, '/api/log'); assert.strictEqual(lg.s, 200); assert.ok(/Unknown block type foo/.test(lg.j.lines.join('\n')) && lg.j.lines.length === 1, JSON.stringify(lg.j));
    console.log('Modrinth-Erkennung ok, Log-Endpunkt ok');
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
