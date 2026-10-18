const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), cp = require('child_process');
const { makeWorld } = require('./world.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-pf-')); process.env.HOME = home; process.env.APPDATA = '';
const w = path.join(home, 'w'); makeWorld(w, () => 'minecraft:stone', [[0, 0]], { name: 'w', yMin: 0, yMax: 16 });
const A = require('../server/anvil.js');
const lvl = A.readLevel(w); console.log('Version.Name:', lvl.version);
assert.strictEqual(A.packFormat(w), null, 'ohne Jar: null');
const name = lvl.version || '26.3';
const dir = path.join(home, '.local/share/ModrinthApp/meta/versions', name); fs.mkdirSync(dir, { recursive: true });
const py = `import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED);z.writestr('version.json',json.dumps({'id':'${name}','pack_version':{'resource_major':97,'resource_minor':0,'data_major':121,'data_minor':0}}));z.writestr('a.class','x'*5000)
for i in range(600): z.writestr('assets/minecraft/blockstates/b%d.json'%i,'{}')
z.writestr('assets/minecraft/blockstates/iron_chain.json','{}')`;
cp.execFileSync('python3', ['-c', py, path.join(dir, name + '.jar')]);
const pf = A.packFormat(w); console.log(pf);
assert.ok(pf && pf.major === 121 && pf.minor === 0);
const kb = A.knownBlocks(w); assert.ok(kb && kb.includes('minecraft:iron_chain') && kb.length === 601, 'knownBlocks ' + (kb && kb.length));
console.log('ok Datapack-Format und Blockliste aus Jar gelesen');
