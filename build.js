const fs = require('fs');
fs.mkdirSync('dist', { recursive: true });
const core = fs.readFileSync('src/core.js', 'utf8');
let html = fs.readFileSync('src/app.html', 'utf8');
if (!html.includes('/*__CORE__*/')) throw new Error('Platzhalter fehlt');
const prod = html.replace('/*__CORE__*/', () => core);
fs.writeFileSync('dist/index.html', prod);
const test = prod
  .replace('https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js', '../node_modules/three/build/three.min.js')
  .replace('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js', '../node_modules/three/examples/js/controls/OrbitControls.js')
  .replace(/<link rel="stylesheet" href="https:\/\/fonts[^>]*>/, '');
fs.writeFileSync('dist/test.html', test);
console.log('gebaut:', (prod.length / 1024).toFixed(1), 'KB');
fs.copyFileSync('src/core.js', 'server/core.js');

/* Paket für den lokalen Betrieb: dist/blockplan-live */
const pkg = 'dist/blockplan-live';
fs.rmSync(pkg, { recursive: true, force: true });
fs.mkdirSync(pkg + '/vendor', { recursive: true });
for (const f of ['server.js', 'anvil.js', 'core.js']) fs.copyFileSync('server/' + f, pkg + '/' + f);
fs.copyFileSync('node_modules/three/build/three.min.js', pkg + '/vendor/three.min.js');
fs.copyFileSync('node_modules/three/examples/js/controls/OrbitControls.js', pkg + '/vendor/OrbitControls.js');
fs.writeFileSync(pkg + '/index.html', prod
  .replace('https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js', '/vendor/three.min.js')
  .replace('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js', '/vendor/OrbitControls.js'));
if (fs.existsSync('release-files')) for (const f of fs.readdirSync('release-files')) fs.copyFileSync('release-files/' + f, pkg + '/' + f);
console.log('Paket:', pkg);
