'use strict';
/* Blockplan Live: lokaler Server. Liest Minecraft-Weltordner und stellt Ausschnitte für den Viewer bereit.
   Start:  node server.js [Weltordner] [--port 8765] [--saves Ordner]      Nur lokal erreichbar (127.0.0.1). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const A = require('./anvil.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PORT = +opt('port', 8765);
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

/* Saves-Ordner: eigene (--saves, mehrere mit ; trennen) plus automatisch gefundene
   (.minecraft, Modrinth App, Prism Launcher). Jeder Ordner bekommt eine Beschriftung für die Auswahl. */
function isDir(d) { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } }
function subdirs(d) { try { return fs.readdirSync(d).filter((n) => isDir(path.join(d, n))); } catch (e) { return []; } }
function findRoots() {
  const roots = [];
  const add = (dir, label) => { const p = path.resolve(dir); if (isDir(p) && !roots.some((r) => r.dir === p)) roots.push({ dir: p, label }); };
  const custom = opt('saves', null);
  if (custom) custom.split(';').filter(Boolean).forEach((c) => add(c.trim().replace(/^"|"$/g, ''), ''));
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  let base;
  if (process.platform === 'win32') base = appdata;
  else if (process.platform === 'darwin') base = path.join(home, 'Library', 'Application Support');
  else base = path.join(home, '.local', 'share');
  const mc = process.platform === 'win32' ? path.join(appdata, '.minecraft') : process.platform === 'darwin' ? path.join(base, 'minecraft') : path.join(home, '.minecraft');
  add(path.join(mc, 'saves'), custom ? 'Minecraft' : '');
  const modrinth = process.platform === 'linux' ? path.join(home, '.local', 'share', 'ModrinthApp') : path.join(base, 'ModrinthApp');
  for (const prof of subdirs(path.join(modrinth, 'profiles'))) add(path.join(modrinth, 'profiles', prof, 'saves'), 'Modrinth: ' + prof);
  const prism = path.join(base, 'PrismLauncher', 'instances');
  for (const inst of subdirs(prism)) for (const mcdir of ['minecraft', '.minecraft']) add(path.join(prism, inst, mcdir, 'saves'), 'Prism: ' + inst);
  /* Hat nur ein Ordner Welten und kein Label, bleibt es wie bisher; sonst mit Label unterscheiden */
  roots.forEach((r) => { if (!r.label && roots.length > 1) r.label = path.basename(path.dirname(r.dir)) || r.dir; });
  return roots;
}
const ROOTS = findRoots();
const SAVES = ROOTS.length ? ROOTS.map((r) => r.dir).join('  |  ') : '(keiner gefunden)';
let activeWorld = null;
if (positional[0]) activeWorld = path.resolve(positional[0]);

const ROOT = __dirname;
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/vendor/three.min.js': ['vendor/three.min.js', 'text/javascript'], '/vendor/OrbitControls.js': ['vendor/OrbitControls.js', 'text/javascript'] };

function listWorlds() {
  const out = [];
  for (const root of ROOTS) {
    for (const n of subdirs(root.dir)) {
      try {
        const st = fs.statSync(path.join(root.dir, n, 'level.dat'));
        out.push({ name: root.label ? root.label + '/' + n : n, label: root.label ? n + '  (' + root.label + ')' : n, mtime: st.mtimeMs });
      } catch (e) { /* kein Weltordner */ }
    }
  }
  return out.sort((x, y) => y.mtime - x.mtime);
}
const worldPath = (name) => {
  for (const root of ROOTS) {
    let rest = null;
    if (root.label) { if (name.startsWith(root.label + '/')) rest = name.slice(root.label.length + 1); } else rest = name;
    if (!rest) continue;
    const p = path.resolve(root.dir, rest);
    if (path.dirname(p) === root.dir && fs.existsSync(path.join(p, 'level.dat'))) return p; /* nur direkte Unterordner */
  }
  return null;
};

function json(req, res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (body.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '')) {
    h['Content-Encoding'] = 'gzip'; res.writeHead(code, h); res.end(zlib.gzipSync(body, { level: 3 }));
  } else { res.writeHead(code, h); res.end(body); }
}

function activeInfo() {
  if (!activeWorld) return null;
  const dims = A.findDims(activeWorld);
  return { path: activeWorld, level: A.readLevel(activeWorld), dims: Object.keys(dims), packFormat: A.packFormat(activeWorld), blocks: A.knownBlocks(activeWorld) };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (STATIC[u.pathname]) {
      const [f, type] = STATIC[u.pathname];
      const data = fs.readFileSync(path.join(ROOT, f));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); return res.end(data);
    }
    if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (u.pathname === '/api/info') {
      return json(req, res, 200, { live: true, saves: SAVES, roots: ROOTS.map((r) => r.dir), worlds: listWorlds(), active: activeInfo() });
    }
    if (u.pathname === '/api/select') {
      const p = worldPath(u.searchParams.get('name') || '');
      if (!p || !fs.existsSync(path.join(p, 'level.dat'))) return json(req, res, 404, { error: 'Welt nicht gefunden.' });
      activeWorld = p; return json(req, res, 200, { active: activeInfo() });
    }
    if (u.pathname === '/api/diag') {
      if (!activeWorld) return json(req, res, 400, { error: 'Keine Welt gewählt.' });
      const dims = A.findDims(activeWorld), dim = u.searchParams.get('dim') || 'overworld';
      if (!dims[dim]) return json(req, res, 404, { error: 'Dimension nicht gefunden.', dims: Object.keys(dims) });
      const cx = Math.floor(Number(u.searchParams.get('x') || 0) / 16), cz = Math.floor(Number(u.searchParams.get('z') || 0) / 16);
      return json(req, res, 200, { world: activeWorld, level: A.readLevel(activeWorld), dimDir: dims[dim], chunk: [cx, cz], diag: A.diagChunk(dims[dim], cx, cz) });
    }
    if (u.pathname === '/api/log') {
      if (!activeWorld) return json(req, res, 400, { error: 'Keine Welt gewählt.' });
      /* Nur lesen: latest.log der Instanz (…/saves/<Welt> → …/logs/latest.log), gefiltert auf Blockplan und Funktionsfehler */
      const file = path.resolve(activeWorld, '..', '..', 'logs', 'latest.log');
      if (!fs.existsSync(file)) return json(req, res, 404, { error: 'latest.log nicht gefunden: ' + file });
      const st = fs.statSync(file), len = Math.min(st.size, 4e6), buf = Buffer.alloc(len), fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
      const lines = buf.toString('utf8').split(/\r?\n/).filter((l) => /blockplan|function|funktion|datapack|data pack/i.test(l) && !/Blockplan Live/.test(l));
      return json(req, res, 200, { file, lines: lines.slice(-40).map((l) => l.slice(0, 500)) });
    }
    if (u.pathname === '/api/box') {
      if (!activeWorld) return json(req, res, 400, { error: 'Keine Welt gewählt.' });
      const q = (k) => { const v = Number(u.searchParams.get(k)); if (!Number.isFinite(v)) throw new Error('Parameter ' + k + ' fehlt.'); return Math.trunc(v); };
      const x = q('x'), y = q('y'), z = q('z'), sx = q('sx'), sy = q('sy'), sz = q('sz');
      if (sx < 1 || sy < 1 || sz < 1 || sx * sy * sz > 30e6) throw new Error('Bereich ist leer oder zu groß.');
      const dims = A.findDims(activeWorld);
      const dim = u.searchParams.get('dim') || 'overworld';
      if (!dims[dim]) return json(req, res, 404, { error: 'Dimension „' + dim + '“ nicht in dieser Welt gefunden.' });
      const s = A.boxSignature(dims[dim], x, z, sx, sz);
      if (u.searchParams.get('sig') === s.sig && s.sig) return json(req, res, 200, { unchanged: true, sig: s.sig, mtime: s.mtime });
      const r = A.readBox(dims[dim], x, y, z, sx, sy, sz);
      return json(req, res, 200, { size: r.size, palette: r.palette, grid: Buffer.from(r.grid.buffer, r.grid.byteOffset, r.grid.byteLength).toString('base64'), unknown: r.unknown, mtime: s.mtime, sig: s.sig });
    }
    if (u.pathname === '/api/datapack' && req.method === 'POST') {
      if (!activeWorld) return json(req, res, 400, { error: 'Keine Welt gewählt.' });
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '') || (req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin))) return json(req, res, 403, { error: 'Nur vom lokalen Viewer erlaubt.' });
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 64e6) req.destroy(); else chunks.push(c); });
      req.on('end', () => {
        try {
          const files = JSON.parse(Buffer.concat(chunks).toString('utf8')).files;
          const names = Object.keys(files || {});
          if (!names.length) throw new Error('Keine Dateien.');
          const ok = (n) => n === 'pack.mcmeta' || /^data\/blockplan\/function\/(build_\d{3}|test)\.mcfunction$/.test(n);
          if (!names.every((n) => ok(n) && typeof files[n] === 'string')) throw new Error('Unzulässiger Dateiname.');
          const base = path.join(activeWorld, 'datapacks', 'blockplan');
          fs.rmSync(path.join(base, 'data', 'blockplan'), { recursive: true, force: true }); /* nur unser eigener Ordner */
          for (const n of names) { const f = path.join(base, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, files[n], 'utf8'); }
          json(req, res, 200, { path: base, files: names.length });
        } catch (e) { json(req, res, 400, { error: String(e.message || e) }); }
      });
      return;
    }
    res.writeHead(404); res.end('Nicht gefunden');
  } catch (e) {
    json(req, res, 500, { error: String(e && e.message ? e.message : e) });
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error('Port ' + PORT + ' ist belegt. Starte mit --port 8766 oder schließe die andere Instanz.');
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('Blockplan Live läuft:  http://localhost:' + PORT);
  console.log('Saves-Ordner:          ' + SAVES);
  console.log(activeWorld ? 'Welt:                  ' + activeWorld : 'Welt:                  (wird im Browser gewählt)');
  console.log('Beenden mit Strg+C.');
});
