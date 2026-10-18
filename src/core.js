/* Blockplan core: NBT, Schematic-Parser, Mesh, Picking, Materialliste.
   Läuft im Browser und in Node (für Tests). Keine Abhängigkeiten. */
const Blockplan = (function () {
  'use strict';

  /* ------------------------------------------------------------------ NBT */
  function readNBT(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const td = new TextDecoder('utf-8');
    let p = 0;
    const str = () => {
      const n = dv.getUint16(p); p += 2;
      const s = td.decode(u8.subarray(p, p + n)); p += n;
      return s;
    };
    function payload(t) {
      switch (t) {
        case 1: return dv.getInt8(p++);
        case 2: { const v = dv.getInt16(p); p += 2; return v; }
        case 3: { const v = dv.getInt32(p); p += 4; return v; }
        case 4: { const v = Number(dv.getBigInt64(p)); p += 8; return v; }
        case 5: { const v = dv.getFloat32(p); p += 4; return v; }
        case 6: { const v = dv.getFloat64(p); p += 8; return v; }
        case 7: { const n = dv.getInt32(p); p += 4; const a = u8.subarray(p, p + n); p += n; return a; }
        case 8: return str();
        case 9: {
          const et = dv.getUint8(p++); const n = dv.getInt32(p); p += 4;
          const a = new Array(n);
          for (let i = 0; i < n; i++) a[i] = payload(et);
          return a;
        }
        case 10: {
          const o = {};
          for (;;) {
            const ct = dv.getUint8(p++);
            if (ct === 0) break;
            const k = str();
            o[k] = payload(ct);
          }
          return o;
        }
        case 11: {
          const n = dv.getInt32(p); p += 4;
          const a = new Int32Array(n);
          for (let i = 0; i < n; i++) { a[i] = dv.getInt32(p); p += 4; }
          return a;
        }
        case 12: {
          /* Longs als Bitstrom (little endian): words[2k] = low, words[2k+1] = high */
          const n = dv.getInt32(p); p += 4;
          const w = new Uint32Array(n * 2);
          for (let i = 0; i < n; i++) { w[2 * i + 1] = dv.getUint32(p); w[2 * i] = dv.getUint32(p + 4); p += 8; }
          return w;
        }
        default: throw new Error('Unbekannter NBT-Tag ' + t);
      }
    }
    const rt = dv.getUint8(p++);
    if (rt !== 10) throw new Error('Keine gültige NBT-Datei (Wurzel ist kein Compound).');
    const name = str();
    return { name, value: payload(10) };
  }

  function getBits(words, bitPos, bits) {
    const w = bitPos >>> 5, o = bitPos & 31;
    let v = words[w] >>> o;
    if (o + bits > 32) v |= (words[w + 1] || 0) << (32 - o);
    return (v & (bits >= 32 ? 0xFFFFFFFF : (2 ** bits - 1))) >>> 0;
  }

  /* ------------------------------------------------------------- Paletten */
  const AIR = /^minecraft:(air|cave_air|void_air)$/;
  const withNs = (n) => (n.indexOf(':') < 0 ? 'minecraft:' + n : n);

  function stateKey(name, props) {
    const ks = Object.keys(props || {}).sort();
    return ks.length ? name + '[' + ks.map((k) => k + '=' + props[k]).join(',') + ']' : name;
  }
  function parseState(str) {
    const i = str.indexOf('[');
    if (i < 0) return { name: withNs(str), props: {} };
    const props = {};
    str.slice(i + 1, str.lastIndexOf(']')).split(',').forEach((kv) => {
      const j = kv.indexOf('=');
      if (j > 0) props[kv.slice(0, j)] = kv.slice(j + 1);
    });
    return { name: withNs(str.slice(0, i)), props };
  }

  function makePalette() {
    const list = [{ name: 'minecraft:air', props: {}, key: 'minecraft:air', air: true }];
    const map = new Map([['minecraft:air', 0]]);
    return {
      list,
      get(name, props) {
        name = withNs(name);
        if (AIR.test(name)) return 0;
        const key = stateKey(name, props);
        let i = map.get(key);
        if (i === undefined) {
          i = list.length;
          list.push({ name, props: props || {}, key, air: false });
          map.set(key, i);
        }
        return i;
      },
    };
  }

  function finalize(meta, size, grid, palette) {
    const counts = new Uint32Array(palette.length);
    for (let i = 0; i < grid.length; i++) counts[grid[i]]++;
    let total = 0;
    for (let i = 1; i < counts.length; i++) total += counts[i];
    return Object.assign({ size, grid, palette, counts, total }, meta);
  }

  const MAX_CELLS = 250e6;
  function checkVolume(s) {
    const v = s[0] * s[1] * s[2];
    if (!(v > 0)) throw new Error('Die Vorlage ist leer.');
    if (v > MAX_CELLS) throw new Error('Die Vorlage ist mit ' + s.join(' × ') + ' Blöcken zu groß für den Browser.');
  }

  /* ----------------------------------------------------------- Litematica */
  function parseLitematic(root) {
    const regs = Object.entries(root.Regions || {});
    if (!regs.length) throw new Error('Die .litematic enthält keine Regionen.');
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const info = regs.map(([name, r]) => {
      const s = [r.Size.x, r.Size.y, r.Size.z], pp = [r.Position.x, r.Position.y, r.Position.z];
      const a = s.map(Math.abs);
      const o = pp.map((v, i) => v + (s[i] < 0 ? s[i] + 1 : 0));
      for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], o[i]); max[i] = Math.max(max[i], o[i] + a[i]); }
      return { name, r, a, o };
    });
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    checkVolume(size);
    const [GX, GY, GZ] = size;
    const grid = new Uint16Array(GX * GY * GZ);
    const pal = makePalette();
    for (const { r, a, o } of info) {
      const lp = r.BlockStatePalette || [];
      const map = lp.map((e) => pal.get(e.Name, e.Properties || {}));
      const bits = Math.max(2, 32 - Math.clz32(lp.length - 1));
      const words = r.BlockStates || new Uint32Array(0);
      const [sx, sy, sz] = a;
      const ox = o[0] - min[0], oy = o[1] - min[1], oz = o[2] - min[2];
      let i = 0;
      for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
          const row = ((y + oy) * GZ + (z + oz)) * GX + ox;
          for (let x = 0; x < sx; x++, i++) {
            const g = map[getBits(words, i * bits, bits)];
            if (g) grid[row + x] = g;
          }
        }
      }
    }
    const m = root.Metadata || {};
    return finalize({ name: m.Name || 'Litematica-Vorlage', author: m.Author || '', format: 'litematic', dataVersion: root.MinecraftDataVersion }, size, grid, pal.list);
  }

  /* --------------------------------------------------------------- Sponge */
  function parseSponge(root) {
    const s = root.Schematic || root;
    const W = s.Width & 0xFFFF, H = s.Height & 0xFFFF, L = s.Length & 0xFFFF;
    const size = [W, H, L];
    checkVolume(size);
    let sp, data;
    if (s.Blocks && s.Blocks.Palette) { sp = s.Blocks.Palette; data = s.Blocks.Data; }
    else { sp = s.Palette; data = s.BlockData; }
    if (!sp || !data) throw new Error('Sponge-Schematic ohne Palette oder Blockdaten.');
    const pal = makePalette();
    const map = [];
    for (const k of Object.keys(sp)) { const st = parseState(k); map[sp[k]] = pal.get(st.name, st.props); }
    const total = W * H * L;
    const grid = new Uint16Array(total);
    let p = 0;
    for (let i = 0; i < total; i++) {
      let v = 0, shift = 0, b;
      do { b = data[p++]; v |= (b & 0x7F) << shift; shift += 7; } while ((b & 0x80) && p < data.length);
      grid[i] = map[v] || 0;
    }
    const md = s.Metadata || {};
    return finalize({ name: md.Name || 'Schematic', author: md.Author || '', format: 'schem', dataVersion: s.DataVersion }, size, grid, pal.list);
  }

  /* ---------------------------------------------------- Vanilla Structure */
  function parseStructure(root) {
    const size = Array.from(root.size);
    checkVolume(size);
    const [GX, GY, GZ] = size;
    const pal = makePalette();
    const src = root.palette || (root.palettes && root.palettes[0]) || [];
    const map = src.map((e) => pal.get(e.Name, e.Properties || {}));
    const grid = new Uint16Array(GX * GY * GZ);
    for (const b of root.blocks || []) {
      const [x, y, z] = b.pos;
      grid[x + z * GX + y * GX * GZ] = map[b.state] || 0;
    }
    return finalize({ name: 'Structure', author: '', format: 'nbt', dataVersion: root.DataVersion }, size, grid, pal.list);
  }

  function parseSchematic(bytes) {
    const root = readNBT(bytes).value;
    if (root.Regions) return parseLitematic(root);
    if (root.Materials && root.Blocks instanceof Uint8Array) {
      throw new Error('Das alte MCEdit-Format (.schematic) wird nicht unterstützt. Exportiere die Vorlage als .litematic oder .schem.');
    }
    if (root.Schematic || root.Width !== undefined) return parseSponge(root);
    if (root.blocks && root.size) return parseStructure(root);
    throw new Error('Unbekanntes Format. Unterstützt werden .litematic, .schem und .nbt.');
  }

  const isGzip = (u8) => u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;
  async function decompress(u8) {
    if (!isGzip(u8)) return u8;
    const ds = new DecompressionStream('gzip');
    const buf = await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  }

  /* --------------------------------------------------------------- Farben */
  const DYE = {
    white: [233, 236, 236], orange: [240, 118, 19], magenta: [189, 68, 179], light_blue: [58, 175, 217],
    yellow: [248, 197, 39], lime: [112, 185, 25], pink: [237, 141, 172], gray: [62, 68, 71],
    light_gray: [142, 142, 134], cyan: [21, 137, 145], purple: [121, 42, 172], blue: [53, 57, 157],
    brown: [114, 71, 40], green: [84, 109, 27], red: [161, 39, 34], black: [20, 21, 25],
  };
  const WOOD = {
    oak: [184, 148, 95], spruce: [122, 90, 52], birch: [213, 201, 140], jungle: [184, 135, 100],
    acacia: [186, 104, 59], dark_oak: [75, 50, 32], mangrove: [119, 54, 54], cherry: [227, 179, 173],
    pale_oak: [227, 212, 205], bamboo: [193, 173, 80], crimson: [126, 58, 86], warped: [43, 105, 99],
  };
  const COPPER = { '': [196, 112, 79], exposed_: [161, 125, 103], weathered_: [108, 153, 110], oxidized_: [82, 162, 132] };
  const RULES = [
    [/water/, [59, 100, 232]], [/lava/, [230, 95, 16]],
    [/^(deepslate|cobbled_deepslate|polished_deepslate|chiseled_deepslate|reinforced_deepslate)/, [77, 77, 82]],
    [/^deepslate_(bricks|tiles)|^cracked_deepslate/, [70, 70, 74]],
    [/blackstone/, [44, 40, 48]], [/basalt/, [74, 74, 80]], [/tuff/, [108, 109, 102]],
    [/mossy_(cobblestone|stone_brick)/, [106, 125, 94]], [/^moss_/, [89, 109, 45]],
    [/cobblestone/, [122, 122, 122]], [/stone_brick|^stone$|^smooth_stone|chiseled_stone/, [125, 125, 125]],
    [/andesite/, [136, 136, 132]], [/diorite/, [191, 191, 191]], [/granite/, [154, 107, 88]],
    [/calcite/, [223, 224, 220]], [/dripstone/, [134, 107, 92]],
    [/red_sandstone|red_sand$|cut_red_sandstone/, [186, 100, 33]],
    [/sandstone|^sand$|suspicious_sand/, [219, 207, 156]],
    [/gravel/, [131, 127, 126]], [/coarse_dirt|rooted_dirt/, [119, 85, 59]],
    [/podzol/, [91, 63, 24]], [/mycelium/, [111, 99, 105]], [/mud_brick|^mud|packed_mud/, [138, 105, 83]],
    [/grass_block|^grass$|^short_grass|tall_grass|^fern|large_fern/, [93, 154, 58]],
    [/dirt|farmland|path/, [134, 96, 67]], [/clay/, [160, 166, 179]],
    [/snow/, [248, 253, 253]], [/packed_ice|blue_ice/, [141, 180, 250]], [/ice/, [143, 180, 245]],
    [/nether_brick|red_nether/, [45, 21, 25]], [/netherrack/, [110, 48, 48]], [/soul_(sand|soil)/, [81, 62, 50]],
    [/end_stone/, [219, 222, 160]], [/quartz/, [236, 230, 223]], [/purpur/, [167, 127, 167]],
    [/dark_prismarine/, [52, 92, 76]], [/prismarine/, [99, 163, 146]], [/sea_lantern/, [207, 224, 214]],
    [/glowstone/, [171, 134, 84]], [/shroomlight/, [240, 146, 70]], [/obsidian/, [20, 18, 29]],
    [/bedrock/, [86, 86, 86]], [/iron_block|iron_bars|chain|anvil|cauldron|hopper/, [200, 200, 200]],
    [/gold_block/, [246, 208, 62]], [/diamond_block/, [98, 236, 224]], [/emerald_block/, [43, 204, 92]],
    [/lapis_block/, [31, 67, 140]], [/redstone_block/, [170, 24, 8]], [/coal_block/, [16, 16, 16]],
    [/netherite/, [66, 61, 63]], [/amethyst/, [133, 97, 191]],
    [/bookshelf/, [117, 88, 45]], [/crafting_table|barrel|chest|loom|lectern|composter|fletching|cartography|smithing/, [138, 100, 54]],
    [/furnace|smoker|blast_furnace|dispenser|dropper|observer|piston/, [112, 112, 112]],
    [/glass/, [207, 233, 240]], [/tinted_glass/, [60, 50, 70]], [/slime/, [111, 192, 91]], [/honey/, [250, 190, 40]],
    [/hay_block/, [166, 136, 38]], [/pumpkin|jack_o_lantern/, [198, 118, 24]], [/melon/, [111, 145, 30]],
    [/cactus/, [85, 127, 43]], [/sponge/, [195, 192, 74]], [/terracotta/, [152, 94, 67]],
    [/torch|lantern|campfire|fire$|candle/, [250, 190, 70]],
    [/leaves|vine|azalea|bush|sapling|lily_pad|kelp|seagrass|bamboo_sapling|wheat|carrots|potatoes|beetroots/, [70, 120, 42]],
    [/dandelion|sunflower/, [240, 210, 40]], [/poppy|rose|tulip/, [190, 40, 40]], [/lilac|allium|peony/, [180, 110, 190]],
    [/mushroom|brown_mushroom/, [150, 110, 80]], [/redstone|repeater|comparator|lever|rail/, [160, 40, 30]],
    [/bricks?$|brick_/, [150, 89, 75]], [/stone/, [125, 125, 125]],
  ];
  const colorCache = new Map();
  function hashColor(id) {
    let h = 5381;
    for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
    const hue = ((h >>> 0) % 360) / 360;
    const f = (n) => { const k = (n + hue * 12) % 12; return 0.5 - 0.3 * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }
  function baseColor(name) {
    if (colorCache.has(name)) return colorCache.get(name);
    const id = name.replace(/^[^:]*:/, '');
    let c = null, m;
    if ((m = id.match(/^(light_blue|light_gray|white|orange|magenta|yellow|lime|pink|gray|cyan|purple|blue|brown|green|red|black)_(.+)/))) {
      c = DYE[m[1]].slice();
      if (/terracotta/.test(m[2])) c = c.map((v, i) => Math.round(v * 0.62 + [152, 94, 67][i] * 0.38));
    }
    if (!c && (m = id.match(/^(?:stripped_)?(dark_oak|pale_oak|oak|spruce|birch|jungle|acacia|mangrove|cherry|bamboo|crimson|warped)_(.+)/))) {
      c = WOOD[m[1]].slice();
      if (/^(log|wood|stem|hyphae)/.test(m[2]) && !/^stripped/.test(id)) c = c.map((v) => Math.round(v * 0.72));
      if (/^leaves/.test(m[2])) c = m[1] === 'cherry' ? [232, 160, 190] : [64, 112, 38];
    }
    if (!c && (m = id.match(/^(waxed_)?(exposed_|weathered_|oxidized_)?(cut_)?copper/))) c = COPPER[m[2] || ''].slice();
    if (!c) for (const [re, col] of RULES) if (re.test(id)) { c = col.slice(); break; }
    if (!c) c = hashColor(id);
    colorCache.set(name, c);
    return c;
  }

  /* -------------------------------------------------------------- Formen */
  const CUBE = { t: 'cube', solid: true, pass: 0 };
  const TRANSLUCENT = /(^|_)(glass|ice|slime_block|honey_block|water)(_pane)?$|^tinted_glass$|^bubble_column$/;
  const PLANT = /(sapling|dandelion|poppy|orchid|allium|azure_bluet|tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|^fern$|^short_grass$|^grass$|^tall_grass$|^large_fern$|dead_bush|seagrass|kelp|mushroom$|^wheat$|carrots|potatoes|beetroots|sweet_berry_bush|^torchflower|fungus|roots|sprouts|^rose_bush$|^lilac$|^peony$|^sunflower$|pitcher|flowers$|^vine$|lily_pad|^moss_carpet$)/;
  const SMALL = /(torch|lantern|candle|button|lever|flower_pot|potted_|head$|skull|cake|bell|^end_rod|^lightning_rod|^amethyst_cluster|bud$|^redstone_wire$|^tripwire|^string$|^sea_pickle|^turtle_egg|^frogspawn|^sculk_vein|^scaffolding_x)/;

  function box(x0, y0, z0, x1, y1, z1) { return [x0, y0, z0, x1, y1, z1]; }
  function boxesShape(boxes, pass) { return { t: 'boxes', boxes, solid: false, pass: pass || 0 }; }
  const FACING = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };

  function shapeOf(e) {
    const id = e.name.replace(/^[^:]*:/, ''), p = e.props || {};
    const pass = TRANSLUCENT.test(id) ? 1 : 0;
    if (/^(light|barrier|structure_void|structure_block|jigsaw|command_block)/.test(id)) return { t: 'none', solid: false, pass: 0 };
    if (/_slab$/.test(id)) {
      if (p.type === 'double') return CUBE;
      return boxesShape([p.type === 'top' ? box(0, .5, 0, 1, 1, 1) : box(0, 0, 0, 1, .5, 1)]);
    }
    if (/_stairs$/.test(id)) {
      const top = p.half === 'top';
      const base = top ? box(0, .5, 0, 1, 1, 1) : box(0, 0, 0, 1, .5, 1);
      const y0 = top ? 0 : .5, y1 = top ? .5 : 1;
      /* Die hohe Stufe liegt auf der Seite, in die die Treppe zeigt (facing). */
      const step = { north: box(0, y0, 0, 1, y1, .5), south: box(0, y0, .5, 1, y1, 1), east: box(.5, y0, 0, 1, y1, 1), west: box(0, y0, 0, .5, y1, 1) }[p.facing || 'north'];
      return boxesShape([base, step]);
    }
    if (/_fence$/.test(id) || /^nether_brick_fence$/.test(id)) {
      const b = [box(.375, 0, .375, .625, 1, .625)];
      if (p.north === 'true') b.push(box(.4375, .375, 0, .5625, .9, .375));
      if (p.south === 'true') b.push(box(.4375, .375, .625, .5625, .9, 1));
      if (p.west === 'true') b.push(box(0, .375, .4375, .375, .9, .5625));
      if (p.east === 'true') b.push(box(.625, .375, .4375, 1, .9, .5625));
      return boxesShape(b);
    }
    if (/_wall$/.test(id)) {
      const b = [box(.25, 0, .25, .75, p.up === 'false' ? .8 : 1, .75)];
      const h = (v) => (v === 'tall' ? 1 : .8125);
      if (p.north && p.north !== 'none') b.push(box(.3125, 0, 0, .6875, h(p.north), .5));
      if (p.south && p.south !== 'none') b.push(box(.3125, 0, .5, .6875, h(p.south), 1));
      if (p.west && p.west !== 'none') b.push(box(0, 0, .3125, .5, h(p.west), .6875));
      if (p.east && p.east !== 'none') b.push(box(.5, 0, .3125, 1, h(p.east), .6875));
      return boxesShape(b);
    }
    if (/_pane$|^iron_bars$/.test(id)) {
      const b = [box(.4375, 0, .4375, .5625, 1, .5625)];
      if (p.north === 'true') b.push(box(.4375, 0, 0, .5625, 1, .4375));
      if (p.south === 'true') b.push(box(.4375, 0, .5625, .5625, 1, 1));
      if (p.west === 'true') b.push(box(0, 0, .4375, .4375, 1, .5625));
      if (p.east === 'true') b.push(box(.5625, 0, .4375, 1, 1, .5625));
      return boxesShape(b, pass);
    }
    if (/_carpet$/.test(id)) return boxesShape([box(0, 0, 0, 1, .0625, 1)]);
    if (id === 'snow') return boxesShape([box(0, 0, 0, 1, Math.max(1, +p.layers || 1) / 8, 1)]);
    if (/_trapdoor$/.test(id)) {
      if (p.open === 'true') {
        const f = p.facing || 'north';
        return boxesShape([{ north: box(0, 0, 0, 1, 1, .1875), south: box(0, 0, .8125, 1, 1, 1), west: box(0, 0, 0, .1875, 1, 1), east: box(.8125, 0, 0, 1, 1, 1) }[f]]);
      }
      return boxesShape([p.half === 'top' ? box(0, .8125, 0, 1, 1, 1) : box(0, 0, 0, 1, .1875, 1)]);
    }
    if (/_door$/.test(id)) {
      const f = p.facing || 'north';
      return boxesShape([{ north: box(0, 0, .8125, 1, 1, 1), south: box(0, 0, 0, 1, 1, .1875), west: box(.8125, 0, 0, 1, 1, 1), east: box(0, 0, 0, .1875, 1, 1) }[f]]);
    }
    if (/_fence_gate$/.test(id)) {
      const ns = p.facing === 'north' || p.facing === 'south';
      return boxesShape([ns ? box(0, .3125, .4375, 1, .9375, .5625) : box(.4375, .3125, 0, .5625, .9375, 1)]);
    }
    if (/_pressure_plate$|_rail$|^rail$/.test(id)) return boxesShape([box(.0625, 0, .0625, .9375, .0625, .9375)]);
    if (/_bed$/.test(id)) return boxesShape([box(0, .1875, 0, 1, .5625, 1)]);
    if (/(^|_)chest$|^ender_chest$/.test(id)) return boxesShape([box(.0625, 0, .0625, .9375, .875, .9375)]);
    if (/_sign$/.test(id) && !/wall/.test(id)) return boxesShape([box(.4375, 0, .4375, .5625, .9, .5625), box(0, .6, .4375, 1, 1, .5625)]);
    if (/wall_sign|wall_banner|wall_hanging_sign|^ladder$|^vine$/.test(id)) {
      const f = p.facing || 'north';
      return boxesShape([{ north: box(0, .2, .875, 1, .8, 1), south: box(0, .2, 0, 1, .8, .125), west: box(.875, .2, 0, 1, .8, 1), east: box(0, .2, 0, .125, .8, 1) }[f]]);
    }
    if (/lantern$/.test(id)) return boxesShape([box(.3125, 0, .3125, .6875, .5625, .6875)]);
    if (/torch$/.test(id)) return boxesShape([box(.4375, 0, .4375, .5625, .625, .5625)]);
    if (/^(cobweb)$/.test(id)) return boxesShape([box(.1, .1, .1, .9, .9, .9)], 1);
    if (PLANT.test(id)) return boxesShape([box(.25, 0, .25, .75, .75, .75)]);
    if (SMALL.test(id)) return boxesShape([box(.3125, 0, .3125, .6875, .5, .6875)]);
    if (/(^|_)(grindstone|stonecutter|enchanting_table|daylight_detector|brewing_stand|lectern|bell)$/.test(id)) return boxesShape([box(0, 0, 0, 1, .75, 1)]);
    if (/^(farmland|dirt_path|grass_path)$/.test(id)) return boxesShape([box(0, 0, 0, 1, .9375, 1)]);
    if (pass) return { t: 'cube', solid: false, pass: 1 };
    return CUBE;
  }

  function prepare(palette) {
    for (const e of palette) {
      if (e.shape) continue;
      if (e.air) { e.shape = { t: 'none', solid: false, pass: 0 }; e.color = [0, 0, 0]; continue; }
      e.shape = shapeOf(e);
      e.color = baseColor(e.name);
    }
  }

  /* ----------------------------------------------------------------- Mesh */
  const SHADE = [0.80, 0.66, 1.0, 0.5, 0.88, 0.75]; /* +x -x +y -y +z -z */
  function QuadBuf() {
    this.cap = 4096; this.n = 0;
    this.pos = new Float32Array(this.cap * 12);
    this.col = new Float32Array(this.cap * 12);
    this.pal = new Uint16Array(this.cap);
    this.cell = new Uint32Array(this.cap);
    this.cell0 = 0;
  }
  QuadBuf.prototype.grow = function () {
    this.cap *= 2;
    const np = new Float32Array(this.cap * 12); np.set(this.pos); this.pos = np;
    const nc = new Float32Array(this.cap * 12); nc.set(this.col); this.col = nc;
    const nl = new Uint16Array(this.cap); nl.set(this.pal); this.pal = nl;
    const nz = new Uint32Array(this.cap); nz.set(this.cell); this.cell = nz;
  };
  QuadBuf.prototype.face = function (d, x0, y0, z0, x1, y1, z1, r, g, b, pal) {
    if (this.n >= this.cap) this.grow();
    const p = this.pos, o = this.n * 12;
    switch (d) {
      case 0: p[o] = x1; p[o + 1] = y0; p[o + 2] = z0; p[o + 3] = x1; p[o + 4] = y1; p[o + 5] = z0; p[o + 6] = x1; p[o + 7] = y1; p[o + 8] = z1; p[o + 9] = x1; p[o + 10] = y0; p[o + 11] = z1; break;
      case 1: p[o] = x0; p[o + 1] = y0; p[o + 2] = z1; p[o + 3] = x0; p[o + 4] = y1; p[o + 5] = z1; p[o + 6] = x0; p[o + 7] = y1; p[o + 8] = z0; p[o + 9] = x0; p[o + 10] = y0; p[o + 11] = z0; break;
      case 2: p[o] = x0; p[o + 1] = y1; p[o + 2] = z0; p[o + 3] = x0; p[o + 4] = y1; p[o + 5] = z1; p[o + 6] = x1; p[o + 7] = y1; p[o + 8] = z1; p[o + 9] = x1; p[o + 10] = y1; p[o + 11] = z0; break;
      case 3: p[o] = x0; p[o + 1] = y0; p[o + 2] = z1; p[o + 3] = x0; p[o + 4] = y0; p[o + 5] = z0; p[o + 6] = x1; p[o + 7] = y0; p[o + 8] = z0; p[o + 9] = x1; p[o + 10] = y0; p[o + 11] = z1; break;
      case 4: p[o] = x1; p[o + 1] = y0; p[o + 2] = z1; p[o + 3] = x1; p[o + 4] = y1; p[o + 5] = z1; p[o + 6] = x0; p[o + 7] = y1; p[o + 8] = z1; p[o + 9] = x0; p[o + 10] = y0; p[o + 11] = z1; break;
      default: p[o] = x0; p[o + 1] = y0; p[o + 2] = z0; p[o + 3] = x0; p[o + 4] = y1; p[o + 5] = z0; p[o + 6] = x1; p[o + 7] = y1; p[o + 8] = z0; p[o + 9] = x1; p[o + 10] = y0; p[o + 11] = z0;
    }
    const s = SHADE[d], c = this.col;
    for (let k = 0; k < 4; k++) { c[o + 3 * k] = r * s; c[o + 3 * k + 1] = g * s; c[o + 3 * k + 2] = b * s; }
    this.cell[this.n] = this.cell0;
    this.pal[this.n++] = pal;
  };
  QuadBuf.prototype.indices = function () {
    const idx = new Uint32Array(this.n * 6);
    for (let q = 0, i = 0; q < this.n; q++, i += 6) { const v = q * 4; idx[i] = v; idx[i + 1] = v + 1; idx[i + 2] = v + 2; idx[i + 3] = v; idx[i + 4] = v + 2; idx[i + 5] = v + 3; }
    return idx;
  };

  const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  function buildMesh(model) {
    const [GX, GY, GZ] = model.size, grid = model.grid, pal = model.palette;
    prepare(pal);
    const bufs = [new QuadBuf(), new QuadBuf()];
    const starts = [new Uint32Array(GY + 1), new Uint32Array(GY + 1)];
    const solid = pal.map((e) => e.shape.solid);
    for (let y = 0; y < GY; y++) {
      starts[0][y] = bufs[0].n; starts[1][y] = bufs[1].n;
      for (let z = 0; z < GZ; z++) {
        for (let x = 0; x < GX; x++) {
          const idx = grid[x + z * GX + y * GX * GZ];
          if (!idx) continue;
          const e = pal[idx], sh = e.shape;
          if (sh.t === 'none') continue;
          const q = bufs[sh.pass];
          q.cell0 = x + z * GX + y * GX * GZ;
          const j = 1 + (((x * 7 + y * 13 + z * 17) % 5) - 2) * 0.012;
          const r = Math.min(1, e.color[0] / 255 * j), g = Math.min(1, e.color[1] / 255 * j), b = Math.min(1, e.color[2] / 255 * j);
          if (sh.t === 'cube') {
            for (let d = 0; d < 6; d++) {
              const nx = x + NB[d][0], ny = y + NB[d][1], nz = z + NB[d][2];
              let n = 0;
              if (nx >= 0 && ny >= 0 && nz >= 0 && nx < GX && ny < GY && nz < GZ) n = grid[nx + nz * GX + ny * GX * GZ];
              if (n && solid[n]) continue;
              if (sh.pass && n === idx) continue;
              q.face(d, x, y, z, x + 1, y + 1, z + 1, r, g, b, idx);
            }
          } else {
            for (const bx of sh.boxes) {
              for (let d = 0; d < 6; d++) {
                const ax = d >> 1, hi = (d & 1) === 0;
                const edge = hi ? bx[3 + ax] === 1 : bx[ax] === 0;
                if (edge) {
                  const nx = x + NB[d][0], ny = y + NB[d][1], nz = z + NB[d][2];
                  if (nx >= 0 && ny >= 0 && nz >= 0 && nx < GX && ny < GY && nz < GZ) {
                    const n = grid[nx + nz * GX + ny * GX * GZ];
                    if (n && solid[n]) continue;
                  }
                }
                q.face(d, x + bx[0], y + bx[1], z + bx[2], x + bx[3], y + bx[4], z + bx[5], r, g, b, idx);
              }
            }
          }
        }
      }
    }
    starts[0][GY] = bufs[0].n; starts[1][GY] = bufs[1].n;
    return { opaque: bufs[0], glass: bufs[1], startsOpaque: starts[0], startsGlass: starts[1] };
  }

  /* -------------------------------------------------------------- Picking */
  /* o, d in Gitterkoordinaten (1 Einheit = 1 Block). Liefert die erste
     belegte Zelle im Bereich y0..y1 oder null. */
  function raycast(model, o, d, y0, y1) {
    const [GX, GY, GZ] = model.size, grid = model.grid;
    const lo = [0, y0, 0], hi = [GX, y1 + 1, GZ];
    let tmin = 0, tmax = Infinity;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-12) { if (o[a] < lo[a] || o[a] > hi[a]) return null; continue; }
      let t1 = (lo[a] - o[a]) / d[a], t2 = (hi[a] - o[a]) / d[a];
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    const t0 = tmin + 1e-6;
    const px = o[0] + d[0] * t0, py = o[1] + d[1] * t0, pz = o[2] + d[2] * t0;
    let x = Math.min(GX - 1, Math.max(0, Math.floor(px)));
    let y = Math.min(y1, Math.max(y0, Math.floor(py)));
    let z = Math.min(GZ - 1, Math.max(0, Math.floor(pz)));
    const sx = d[0] > 0 ? 1 : -1, sy = d[1] > 0 ? 1 : -1, sz = d[2] > 0 ? 1 : -1;
    const dx = d[0] === 0 ? Infinity : Math.abs(1 / d[0]);
    const dy = d[1] === 0 ? Infinity : Math.abs(1 / d[1]);
    const dz = d[2] === 0 ? Infinity : Math.abs(1 / d[2]);
    let tx = d[0] === 0 ? Infinity : (sx > 0 ? x + 1 - px : px - x) * dx;
    let ty = d[1] === 0 ? Infinity : (sy > 0 ? y + 1 - py : py - y) * dy;
    let tz = d[2] === 0 ? Infinity : (sz > 0 ? z + 1 - pz : pz - z) * dz;
    let face = [0, 0, 0];
    for (let guard = 0; guard < GX + GY + GZ + 8; guard++) {
      const idx = grid[x + z * GX + y * GX * GZ];
      if (idx) return { x, y, z, idx, face };
      if (tx < ty && tx < tz) { x += sx; tx += dx; face = [-sx, 0, 0]; }
      else if (ty < tz) { y += sy; ty += dy; face = [0, -sy, 0]; }
      else { z += sz; tz += dz; face = [0, 0, -sz]; }
      if (x < 0 || x >= GX || y < y0 || y > y1 || z < 0 || z >= GZ) return null;
    }
    return null;
  }

  /* ------------------------------------------------------- Materialliste */
  const NO_ITEM = /^(water|lava|bubble_column|fire|soul_fire|nether_portal|end_portal|end_gateway|moving_piston|piston_head|void_air|cave_air|air|light|barrier|structure_void|frosted_ice|redstone_wall_torch_x)$/;
  function itemsFor(e) {
    let id = e.name.replace(/^[^:]*:/, ''), p = e.props || {}, per = 1;
    if (NO_ITEM.test(id)) return [];
    if (/_slab$/.test(id) && p.type === 'double') per = 2;
    if (/_door$/.test(id) && p.half === 'upper') return [];
    if (/_bed$/.test(id) && p.part === 'head') return [];
    if (/^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|tall_seagrass|pitcher_plant)$/.test(id) && p.half === 'upper') return [];
    if (id === 'sea_pickle') per = +p.pickles || 1;
    if (/candle$/.test(id)) per = +p.candles || 1;
    if (id === 'snow') per = +p.layers || 1;
    if (id === 'wall_torch') id = 'torch';
    else if (id === 'redstone_wall_torch') id = 'redstone_torch';
    else if (id === 'soul_wall_torch') id = 'soul_torch';
    else if (/_wall_sign$/.test(id)) id = id.replace('_wall_sign', '_sign');
    else if (/_wall_hanging_sign$/.test(id)) id = id.replace('_wall_hanging_sign', '_hanging_sign');
    else if (/_wall_banner$/.test(id)) id = id.replace('_wall_banner', '_banner');
    else if (id === 'redstone_wire') id = 'redstone';
    else if (id === 'tripwire') id = 'string';
    else if (id === 'wheat') id = 'wheat_seeds';
    else if (id === 'carrots') id = 'carrot';
    else if (id === 'potatoes') id = 'potato';
    else if (id === 'beetroots') id = 'beetroot_seeds';
    else if (id === 'kelp_plant') id = 'kelp';
    else if (id === 'grass_block' || id === 'farmland' || id === 'dirt_path') { /* Block selbst */ }
    if (/^potted_/.test(id)) return [{ item: 'minecraft:flower_pot', per: 1 }, { item: 'minecraft:' + id.slice(7), per: 1 }];
    return [{ item: 'minecraft:' + id, per }];
  }
  function stackSize(item) {
    const id = item.replace(/^[^:]*:/, '');
    if (/(_sign|_banner|snowball|ender_pearl|^egg$|bucket)$/.test(id)) return 16;
    if (/(_bed|boat|minecart|shulker_box|^cake$)$/.test(id)) return 1;
    return 64;
  }
  function materials(model) {
    const tot = new Map();
    model.palette.forEach((e, i) => {
      const c = model.counts[i];
      if (!c || e.air) return;
      for (const it of itemsFor(e)) tot.set(it.item, (tot.get(it.item) || 0) + c * it.per);
    });
    return Array.from(tot, ([item, count]) => ({ item, count, stack: stackSize(item) })).sort((a, b) => b.count - a.count || (a.item < b.item ? -1 : 1));
  }
  function setblockCommand(e, x, y, z) {
    return 'setblock ' + x + ' ' + y + ' ' + z + ' ' + e.key.replace(/^minecraft:/, '');
  }

  /* ------------------------------------------------------ Modell-Builder */
  function ModelBuilder(sx, sy, sz) {
    this.size = [sx, sy, sz];
    this.grid = new Uint16Array(sx * sy * sz);
    this.pal = makePalette();
    this.cache = new Map();
  }
  ModelBuilder.prototype.set = function (x, y, z, state) {
    const [sx, sy, sz] = this.size;
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
    let i = this.cache.get(state);
    if (i === undefined) { const st = parseState(state); i = this.pal.get(st.name, st.props); this.cache.set(state, i); }
    this.grid[x + z * sx + y * sx * sz] = i;
  };
  ModelBuilder.prototype.fill = function (x0, y0, z0, x1, y1, z1, state) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, state);
  };
  ModelBuilder.prototype.finish = function (meta) {
    return finalize(meta || {}, this.size, this.grid, this.pal.list);
  };

  /* Beispiel: kleine Burg, damit das Tool beim Öffnen etwas zeigt. */
  function makeSample() {
    const S = 21, H = 22;
    const m = new ModelBuilder(S, H, S);
    const sb = 'minecraft:stone_bricks', cb = 'minecraft:cobblestone', mc = 'minecraft:mossy_stone_bricks';
    m.fill(0, 0, 0, S - 1, 0, S - 1, cb);
    m.fill(1, 1, 1, S - 2, 1, S - 2, 'minecraft:grass_block');
    /* Ringmauer */
    for (let y = 1; y <= 7; y++) {
      for (let i = 0; i < S; i++) {
        const st = y < 3 && (i % 3 === 0) ? mc : sb;
        m.set(i, y, 0, st); m.set(i, y, S - 1, st); m.set(0, y, i, st); m.set(S - 1, y, i, st);
      }
    }
    /* Zinnen und Wehrgang */
    for (let i = 0; i < S; i++) {
      const merl = i % 2 === 0 ? sb : 'minecraft:air';
      m.set(i, 8, 0, merl); m.set(i, 8, S - 1, merl); m.set(0, 8, i, merl); m.set(S - 1, 8, i, merl);
    }
    /* Tor */
    for (let y = 2; y <= 5; y++) for (let x = 9; x <= 11; x++) m.set(x, y, S - 1, 'minecraft:air');
    m.set(9, 6, S - 1, 'minecraft:stone_brick_stairs[facing=east,half=top]');
    m.set(11, 6, S - 1, 'minecraft:stone_brick_stairs[facing=west,half=top]');
    m.set(10, 6, S - 1, 'minecraft:stone_brick_slab[type=top]');
    m.set(9, 2, S - 1, 'minecraft:dark_oak_door[facing=south,half=lower,hinge=left,open=false]');
    m.set(9, 3, S - 1, 'minecraft:dark_oak_door[facing=south,half=upper,hinge=left,open=false]');
    m.set(11, 2, S - 1, 'minecraft:dark_oak_door[facing=south,half=lower,hinge=right,open=false]');
    m.set(11, 3, S - 1, 'minecraft:dark_oak_door[facing=south,half=upper,hinge=right,open=false]');
    m.set(8, 4, S, 'minecraft:air');
    m.set(8, 4, S - 2, 'minecraft:wall_torch[facing=north]');
    m.set(12, 4, S - 2, 'minecraft:wall_torch[facing=north]');
    /* Ecktürme */
    for (const [tx, tz] of [[0, 0], [S - 5, 0], [0, S - 5], [S - 5, S - 5]]) {
      m.fill(tx, 1, tz, tx + 4, 11, tz + 4, cb);
      m.fill(tx + 1, 2, tz + 1, tx + 3, 11, tz + 3, 'minecraft:air');
      for (let i = 0; i < 5; i++) {
        const mer = i % 2 === 0 ? sb : 'minecraft:air';
        m.set(tx + i, 12, tz, mer); m.set(tx + i, 12, tz + 4, mer); m.set(tx, 12, tz + i, mer); m.set(tx + 4, 12, tz + i, mer);
      }
      m.set(tx + 2, 8, tz, 'minecraft:glass_pane[north=false,south=false,east=false,west=false]');
      m.set(tx + 2, 8, tz + 4, 'minecraft:glass_pane[north=false,south=false,east=false,west=false]');
      m.set(tx + 2, 11, tz + 2, 'minecraft:lantern[hanging=false]');
    }
    /* Bergfried */
    m.fill(6, 1, 6, 14, 12, 14, 'minecraft:oak_planks');
    m.fill(7, 2, 7, 13, 12, 13, 'minecraft:air');
    for (let y = 1; y <= 12; y++) for (let i = 6; i <= 14; i++) {
      const wood = y % 4 === 0 ? 'minecraft:stripped_oak_log' : sb;
      m.set(i, y, 6, wood); m.set(i, y, 14, wood); m.set(6, y, i, wood); m.set(14, y, i, wood);
    }
    for (const y of [3, 7, 10]) for (const x of [8, 10, 12]) {
      m.set(x, y, 14, 'minecraft:glass_pane[north=false,south=false,east=false,west=false]');
      m.set(x, y, 6, 'minecraft:glass_pane[north=false,south=false,east=false,west=false]');
    }
    m.fill(7, 5, 7, 13, 5, 13, 'minecraft:spruce_planks');
    m.fill(7, 9, 7, 13, 9, 13, 'minecraft:spruce_planks');
    for (const [x, z] of [[7, 7], [13, 7], [7, 13], [13, 13]]) { m.set(x, 6, z, 'minecraft:oak_fence[north=false,south=false,east=false,west=false]'); m.set(x, 7, z, 'minecraft:oak_fence[north=false,south=false,east=false,west=false]'); m.set(x, 8, z, 'minecraft:lantern[hanging=true]'); }
    m.set(10, 2, 13, 'minecraft:red_bed[facing=north,part=foot]');
    m.set(10, 2, 12, 'minecraft:red_bed[facing=north,part=head]');
    m.set(8, 2, 8, 'minecraft:crafting_table'); m.set(9, 2, 8, 'minecraft:furnace[facing=south]');
    /* Satteldach aus Treppen, First entlang Z, Giebel gefüllt */
    for (let k = 0; k < 5; k++) {
      const y = 13 + k;
      for (let z = 5; z <= 15; z++) {
        m.set(5 + k, y, z, 'minecraft:spruce_stairs[facing=east,half=bottom]');
        m.set(15 - k, y, z, 'minecraft:spruce_stairs[facing=west,half=bottom]');
      }
      for (let x = 6 + k; x <= 14 - k; x++) { m.set(x, y, 6, 'minecraft:oak_planks'); m.set(x, y, 14, 'minecraft:oak_planks'); }
    }
    m.fill(10, 17, 5, 10, 17, 15, 'minecraft:spruce_slab[type=bottom]');
    /* Wassergraben-Rand und Bäume */
    m.set(3, 2, 10, 'minecraft:oak_log[axis=y]'); m.set(3, 3, 10, 'minecraft:oak_log[axis=y]'); m.set(3, 4, 10, 'minecraft:oak_log[axis=y]');
    m.fill(2, 5, 9, 4, 5, 11, 'minecraft:oak_leaves[distance=1,persistent=true]');
    m.set(3, 6, 10, 'minecraft:oak_leaves[distance=1,persistent=true]');
    m.set(17, 2, 10, 'minecraft:poppy'); m.set(16, 2, 11, 'minecraft:dandelion');
    return m.finish({ name: 'Beispiel: kleine Burg', author: 'Blockplan', format: 'beispiel' });
  }



  /* ------------------------------------------------------------ Drehen */
  const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
  const RAIL = { north_south: 'east_west', east_west: 'north_south', ascending_north: 'ascending_east', ascending_east: 'ascending_south', ascending_south: 'ascending_west', ascending_west: 'ascending_north', north_east: 'east_south', east_south: 'south_west', south_east: 'south_west', south_west: 'north_west', north_west: 'north_east' };
  RAIL.south_east = 'south_west'; /* Alias-Schreibweise */
  function rotateProps(props) {
    const o = {};
    for (const k of Object.keys(props || {})) {
      const v = props[k];
      if (CW[k] !== undefined) o[CW[k]] = v; /* north/east/south/west: Zaun, Scheibe, Mauer, Ranke, Redstone */
      else if (k === 'facing' && CW[v]) o[k] = CW[v];
      else if (k === 'axis') o[k] = v === 'x' ? 'z' : v === 'z' ? 'x' : v;
      else if (k === 'rotation' && /^\d+$/.test(v)) o[k] = String((+v + 4) % 16);
      else if (k === 'shape' && RAIL[v]) o[k] = RAIL[v];
      else o[k] = v;
    }
    return o;
  }
  /* Dreht die Vorlage um turns*90 Grad im Uhrzeigersinn (Blick von oben, Norden oben). Gibt ein neues Modell zurück. */
  function rotateModel(model, turns) {
    turns = ((turns % 4) + 4) % 4;
    if (!turns) return model;
    let cur = model;
    for (let t = 0; t < turns; t++) {
      const [GX, GY, GZ] = cur.size, nx = GZ, nz = GX, grid = new Uint16Array(cur.grid.length);
      for (let y = 0; y < GY; y++) for (let z = 0; z < GZ; z++) for (let x = 0; x < GX; x++) {
        grid[(GZ - 1 - z) + x * nx + y * nx * nz] = cur.grid[x + z * GX + y * GX * GZ];
      }
      const palette = cur.palette.map((e) => {
        if (e.air) return { name: e.name, props: {}, key: e.key, air: true };
        const props = rotateProps(e.props);
        return { name: e.name, props, key: stateKey(e.name, props) };
      });
      cur = Object.assign({}, cur, { size: [nx, GY, nz], grid, palette });
    }
    return cur;
  }

  /* ------------------------------------------- Blocknamen je Spielversion */
  const RENAMES = [{ min: [1, 21, 9], map: { 'minecraft:chain': 'minecraft:iron_chain' } }];
  const EXEMPT = /^minecraft:(air|cave_air|void_air|water|lava|bubble_column|moving_piston|piston_head|fire|soul_fire|nether_portal|end_portal|end_gateway|light|structure_void|frosted_ice|redstone_wall_torch)$/;
  function gameAtLeast(ver, a, b, c) {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(ver || ''));
    if (!m) return false;
    const v = [+m[1], +m[2], +(m[3] || 0)], t = [a, b, c];
    if (v[0] >= 26) return true; /* neues Versionsschema ab 26.1, jünger als 1.21.x */
    for (let i = 0; i < 3; i++) { if (v[i] !== t[i]) return v[i] > t[i]; }
    return true;
  }
  /* Name so, wie ihn die Spielversion kennt (z. B. chain wurde in 1.21.9 zu iron_chain) */
  function upgradeName(name, gameVersion) {
    let n = name;
    if (gameVersion) for (const r of RENAMES) if (gameAtLeast(gameVersion, r.min[0], r.min[1], r.min[2]) && r.map[n]) n = r.map[n];
    return n;
  }
  function upgradedKey(e, gameVersion) { return stateKey(upgradeName(e.name, gameVersion), e.props); }
  function isKnownBlock(name, known) { return !known || EXEMPT.test(name) || known.has(name); }

  /* ------------------------------------------------------ Befehlsexport */
  const FILL_CAP = 32768; /* Standardlimit von /fill und /clone */

  function splitBox(x0, y0, z0, x1, y1, z1, cap, out) {
    const dx = x1 - x0 + 1, dy = y1 - y0 + 1, dz = z1 - z0 + 1;
    if (dx * dy * dz <= cap) { out.push([x0, y0, z0, x1, y1, z1]); return; }
    if (dy >= dx && dy >= dz) { const m = y0 + (dy >> 1) - 1; splitBox(x0, y0, z0, x1, m, z1, cap, out); splitBox(x0, m + 1, z0, x1, y1, z1, cap, out); }
    else if (dx >= dz) { const m = x0 + (dx >> 1) - 1; splitBox(x0, y0, z0, m, y1, z1, cap, out); splitBox(m + 1, y0, z0, x1, y1, z1, cap, out); }
    else { const m = z0 + (dz >> 1) - 1; splitBox(x0, y0, z0, x1, y1, m, cap, out); splitBox(x0, y0, m + 1, x1, y1, z1, cap, out); }
  }

  /* Fasst gleiche Blöcke zu Quadern zusammen und erzeugt /fill- und /setblock-Befehle.
     o: { origin:[x,y,z], y0, y1, status (Uint8Array, nur 2=fehlt und 3=falsch werden gesetzt), clear:boolean, cap } */
  function exportCommands(model, o) {
    o = o || {};
    const [GX, GY, GZ] = model.size, grid = model.grid, pal = model.palette, per = GX * GZ;
    prepare(pal);
    const org = o.origin || [0, 0, 0];
    const ya = Math.max(0, o.y0 === undefined ? 0 : o.y0), yb = Math.min(GY - 1, o.y1 === undefined ? GY - 1 : o.y1);
    const st = o.status || null, cap = o.cap || FILL_CAP;
    const keys = pal.map((e) => (e.air ? e.key : upgradedKey(e, o.gameVersion)));
    const unknownNames = new Set();
    const okPal = pal.map((e, i) => {
      if (e.air) return true;
      const nm = upgradeName(e.name, o.gameVersion);
      if (isKnownBlock(nm, o.known)) return true;
      unknownNames.add(nm); return false;
    });
    const want = (i) => { const g = grid[i]; if (!g || pal[g].shape.t === 'none' || !okPal[g]) return false; return !st || st[i] === 2 || st[i] === 3; };
    const used = new Uint8Array(grid.length);
    const boxes = [];
    for (let y = ya; y <= yb; y++) {
      for (let z = 0; z < GZ; z++) {
        for (let x = 0; x < GX; x++) {
          const i = x + z * GX + y * per;
          if (used[i] || !want(i)) continue;
          const g = grid[i];
          const ok = (xx, yy, zz) => { const j = xx + zz * GX + yy * per; return !used[j] && grid[j] === g && want(j); };
          let x1 = x;
          while (x1 + 1 < GX && (x1 - x + 2) <= cap && ok(x1 + 1, y, z)) x1++;
          const w = x1 - x + 1;
          let z1 = z;
          while (z1 + 1 < GZ && w * (z1 - z + 2) <= cap) {
            let all = true;
            for (let xx = x; xx <= x1; xx++) if (!ok(xx, y, z1 + 1)) { all = false; break; }
            if (!all) break;
            z1++;
          }
          const d = z1 - z + 1;
          let y1 = y;
          while (y1 + 1 <= yb && w * d * (y1 - y + 2) <= cap) {
            let all = true;
            for (let zz = z; zz <= z1 && all; zz++) for (let xx = x; xx <= x1; xx++) if (!ok(xx, y1 + 1, zz)) { all = false; break; }
            if (!all) break;
            y1++;
          }
          for (let yy = y; yy <= y1; yy++) for (let zz = z; zz <= z1; zz++) for (let xx = x; xx <= x1; xx++) used[xx + zz * GX + yy * per] = 1;
          boxes.push({ x0: x, y0: y, z0: z, x1, y1, z1, g });
        }
      }
    }
    /* Erst volle Blöcke, dann alles Übrige (Fackeln, Türen, Leitern ...), damit der Halt schon steht. Innerhalb davon von unten nach oben. */
    const phase = (b) => (pal[b.g].shape.t === 'cube' ? 0 : 1);
    boxes.sort((a, b) => phase(a) - phase(b) || a.y0 - b.y0 || a.z0 - b.z0 || a.x0 - b.x0);
    const cmds = [];
    let clearN = 0, fillN = 0, setN = 0, blocks = 0;
    if (o.clear) {
      const parts = [];
      splitBox(0, ya, 0, GX - 1, yb, GZ - 1, cap, parts);
      for (const p of parts) { cmds.push('fill ' + (org[0] + p[0]) + ' ' + (org[1] + p[1]) + ' ' + (org[2] + p[2]) + ' ' + (org[0] + p[3]) + ' ' + (org[1] + p[4]) + ' ' + (org[2] + p[5]) + ' minecraft:air'); clearN++; }
    }
    for (const b of boxes) {
      const st1 = keys[b.g], vol = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1);
      blocks += vol;
      if (vol === 1) { cmds.push('setblock ' + (org[0] + b.x0) + ' ' + (org[1] + b.y0) + ' ' + (org[2] + b.z0) + ' ' + st1); setN++; }
      else { cmds.push('fill ' + (org[0] + b.x0) + ' ' + (org[1] + b.y0) + ' ' + (org[2] + b.z0) + ' ' + (org[0] + b.x1) + ' ' + (org[1] + b.y1) + ' ' + (org[2] + b.z1) + ' ' + st1); fillN++; }
    }
    return { commands: cmds, stats: { blocks, fill: fillN, setblock: setN, clear: clearN, total: cmds.length, skipped: [...unknownNames] } };
  }

  function splitFiles(commands, perFile) {
    perFile = perFile || 30000; /* bleibt unter dem Standardlimit von 65536 Befehlen pro Ausführung */
    const files = [];
    for (let i = 0; i < commands.length; i += perFile) files.push(commands.slice(i, i + perFile));
    return files;
  }

  function buildDatapack(fileLines, o) {
    o = o || {};
    const out = {};
    out['pack.mcmeta'] = JSON.stringify({ pack: { description: o.description || 'Blockplan', min_format: o.minFormat === undefined ? 88 : o.minFormat, max_format: o.maxFormat === undefined ? 999 : o.maxFormat } }, null, 2) + '\n';
    out['data/blockplan/function/test.mcfunction'] = 'say Blockplan-Datapack ist geladen\n';
    fileLines.forEach((lines, i) => {
      const n = String(i + 1).padStart(3, '0');
      out['data/blockplan/function/build_' + n + '.mcfunction'] = '# Blockplan, Teil ' + (i + 1) + ' von ' + fileLines.length + ', ' + lines.length + ' Befehle\n' + lines.join('\n') + '\n';
    });
    return out;
  }

  /* ZIP ohne Kompression (Methode "stored"), reicht für Textdateien. */
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function makeZip(files) {
    const enc = new TextEncoder(), chunks = [], cen = [];
    let offset = 0;
    for (const [name, data] of Object.entries(files)) {
      const nb = enc.encode(name), db = typeof data === 'string' ? enc.encode(data) : data, crc = crc32(db);
      const lh = new Uint8Array(30 + nb.length), dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true); dv.setUint32(18, db.length, true); dv.setUint32(22, db.length, true); dv.setUint16(26, nb.length, true);
      lh.set(nb, 30);
      const ch = new Uint8Array(46 + nb.length), cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, db.length, true); cv.setUint32(24, db.length, true); cv.setUint16(28, nb.length, true); cv.setUint32(42, offset, true);
      ch.set(nb, 46);
      chunks.push(lh, db); cen.push(ch); offset += lh.length + db.length;
    }
    const cdSize = cen.reduce((a, c) => a + c.length, 0);
    const end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, cen.length, true); ev.setUint16(10, cen.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    const all = chunks.concat(cen, [end]), total = all.reduce((a, c) => a + c.length, 0), out = new Uint8Array(total);
    let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }

  return {
    readNBT, getBits, parseSchematic, parseLitematic, parseSponge, parseStructure, decompress, isGzip,
    parseState, stateKey, baseColor, shapeOf, prepare, buildMesh, raycast, materials, itemsFor, stackSize,
    setblockCommand, ModelBuilder, makeSample, exportCommands, upgradeName, upgradedKey, isKnownBlock, rotateModel, splitFiles, buildDatapack, makeZip, crc32, splitBox,
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Blockplan;
