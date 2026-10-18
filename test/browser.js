let chromium; try { ({ chromium } = require('playwright')); } catch (e) { console.error('Für die UI-Tests: npm i -D playwright && npx playwright install chromium'); process.exit(2); }
const launchOpts = (extra) => Object.assign({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'] }, process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}, extra);
const path = require('path');
const url = 'file://' + path.resolve(__dirname, '../dist/test.html');
(async () => {
  const browser = await chromium.launch(launchOpts());
  const errors = [];
  async function open(w, h, scheme) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, hasTouch: w < 600, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(w + ': ' + m.text()); });
    page.on('pageerror', (e) => errors.push(w + ' pageerror: ' + e.message));
    await page.goto(url);
    await page.waitForTimeout(600);
    return page;
  }
  /* Desktop hell */
  let page = await open(1280, 800, 'light');
  await page.screenshot({ path: 'dist/shot-desktop-light.png' });
  const info = await page.evaluate(() => ({ total: __bp.S.model.total, mats: __bp.S.mats.length, layer: __bp.S.layer, gl: !!document.querySelector('#c3d') && !document.querySelector('#c3d').hidden, overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth }));
  console.log('start', JSON.stringify(info));
  /* Klick auf die Mitte der 3D-Ansicht wählt einen Block */
  const box = await page.locator('#c3d').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.waitForTimeout(200);
  console.log('hud:', JSON.stringify(await page.locator('#hud').innerText()));
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.waitForTimeout(200);
  console.log('sel:', JSON.stringify(await page.evaluate(() => __bp.S.sel)));
  console.log('pane:', (await page.locator('#pane').innerText()).replace(/\n+/g, ' | ').slice(0, 220));
  await page.screenshot({ path: 'dist/shot-desktop-select.png' });
  /* Nachbar-Navigation */
  const before = await page.evaluate(() => JSON.stringify(__bp.S.sel));
  await page.keyboard.press('ArrowRight');
  const after = await page.evaluate(() => JSON.stringify(__bp.S.sel));
  console.log('Pfeil rechts:', before, '→', after);
  /* Ebenenplan */
  await page.click('#v2d'); await page.waitForTimeout(200);
  await page.screenshot({ path: 'dist/shot-plan-light.png' });
  const c2 = await page.locator('#c2d').boundingBox();
  await page.mouse.click(c2.x + c2.width / 2, c2.y + c2.height / 2);
  console.log('2D sel:', JSON.stringify(await page.evaluate(() => __bp.S.sel)));
  /* Material */
  await page.click('#tb-mat'); await page.waitForTimeout(100);
  const rows = await page.locator('#pane tr.pick').count();
  console.log('Materialzeilen', rows);
  await page.locator('#pane tr.pick').nth(1).click(); await page.waitForTimeout(150);
  console.log('Highlight-Menge', await page.evaluate(() => __bp.S.hl && __bp.S.hl.size));
  await page.click('#v3d'); await page.waitForTimeout(300);
  await page.screenshot({ path: 'dist/shot-desktop-highlight.png' });
  await page.evaluate(() => { __bp.S.hl = null; });
  /* Ebenen */
  await page.click('#tb-layer'); await page.waitForTimeout(100);
  await page.locator('#pane tr.pick').nth(3).click(); await page.waitForTimeout(250);
  console.log('Modus/Ebene', await page.evaluate(() => __bp.S.mode + ' ' + __bp.S.layer));
  await page.screenshot({ path: 'dist/shot-desktop-layer.png' });
  /* Import der Fixture */
  await page.setInputFiles('#file', path.resolve(__dirname, '../dist/fixture.litematic'));
  await page.waitForTimeout(800);
  console.log('Import:', await page.evaluate(() => JSON.stringify({ name: __bp.S.model.name, total: __bp.S.model.total, size: __bp.S.model.size, fmt: __bp.S.model.format })), 'msg hidden:', await page.locator('#msg').isHidden());
  await page.close();
  /* Dunkel */
  page = await open(1280, 800, 'dark');
  await page.screenshot({ path: 'dist/shot-desktop-dark.png' });
  await page.click('#v2d'); await page.waitForTimeout(200);
  await page.screenshot({ path: 'dist/shot-plan-dark.png' });
  await page.close();
  /* Handy */
  page = await open(400, 860, 'light');
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  console.log('Handy Breite', JSON.stringify(ov));
  await page.screenshot({ path: 'dist/shot-mobile.png', fullPage: true });
  await page.close();
  await browser.close();
  console.log(errors.length ? 'FEHLER:\n' + errors.join('\n') : 'Keine Konsolenfehler');
})().catch((e) => { console.error('Testlauf fehlgeschlagen:', e); process.exit(1); });
