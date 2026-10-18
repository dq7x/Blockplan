/* Erzeugt dist/blockplan-live-<version>.zip aus dist/blockplan-live (ohne Abhängigkeiten, nur Node nötig zum Ausführen). */
const fs = require('fs');
const path = require('path');
const B = require('../src/core.js');
const version = require('../package.json').version;
const src = path.resolve(__dirname, '../dist/blockplan-live');
if (!fs.existsSync(src)) throw new Error('Erst "npm run build" ausführen.');
const files = {};
(function walk(dir) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else files['blockplan-live/' + path.relative(src, p).split(path.sep).join('/')] = new Uint8Array(fs.readFileSync(p));
  }
})(src);
const out = path.resolve(__dirname, '../dist/blockplan-live-' + version + '.zip');
fs.writeFileSync(out, B.makeZip(files));
console.log('Release:', out, '(' + Object.keys(files).length + ' Dateien)');
