const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');

(async () => {
  const root = __dirname;
  const output = path.resolve(process.argv[2] || path.join(root, '.preview-checks'));
  await fs.mkdir(output, { recursive: true });
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = http.createServer(async (request, response) => {
    const file = path.resolve(root, '.' + (new URL(request.url, 'http://localhost').pathname === '/' ? '/index.html' : decodeURIComponent(new URL(request.url, 'http://localhost').pathname)));
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    try { const body = await fs.readFile(file); response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(body); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  const result = { responsive: [], interactions: [], pageErrors: [], externalRequests: [] };
  try {
    const browserOptions = { headless: true };
    if (process.env.SHELFDOCK_CHROME) browserOptions.executablePath = process.env.SHELFDOCK_CHROME;
    browser = await chromium.launch(browserOptions);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => result.pageErrors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(base)) result.externalRequests.push(request.url()); });
    await page.goto(base + '/assets/social-card.html');
    await page.setViewportSize({ width: 1200, height: 630 });
    await page.screenshot({ path: path.join(root, 'assets/social-card.png') });
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(base);
      const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      assert.ok(overflow.document <= width + 1 && overflow.body <= width + 1, 'Horizontal overflow at ' + width + ': ' + JSON.stringify(overflow));
      await page.screenshot({ path: path.join(output, 'landing-' + width + '.png'), fullPage: true });
      result.responsive.push({ width, overflow: false });
    }
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(base);
    assert.equal(await page.locator('h1').count(), 1);
    assert.match(await page.title(), /ShelfDock/);
    const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    assert.equal(schema.name, 'ShelfDock');
    const canonical = 'https://shelfdock.lexilominite.com/';
    assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'), canonical);
    assert.equal(await page.locator('meta[property="og:url"]').getAttribute('content'), canonical);
    assert.equal(await page.locator('meta[property="og:image"]').getAttribute('content'), canonical + 'assets/social-card.png');
    assert.equal(schema.url, canonical);
    assert.match(await fs.readFile(path.join(root, 'sitemap.xml'), 'utf8'), /<loc>https:\/\/shelfdock\.lexilominite\.com\/<\/loc>/);
    assert.match(await fs.readFile(path.join(root, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/shelfdock\.lexilominite\.com\/sitemap\.xml/);
    result.interactions.push('Canonical, structured data, social metadata and search discovery URLs');
    await page.getByRole('button', { name: /Interface sketches.pdf/ }).click();
    await page.getByRole('button', { name: /Workshop/ }).click();
    await page.getByRole('button', { name: 'Send sample' }).click();
    assert.match(await page.locator('#transfer-status').textContent(), /Interface sketches.pdf to Workshop/);
    result.interactions.push('Keyboard-accessible item + machine selection and simulated send');
    await page.locator('[data-item="Field notes.txt"]').dragTo(page.locator('[data-host="Studio"]'));
    assert.match(await page.locator('#transfer-status').textContent(), /Field notes.txt to Studio/);
    result.interactions.push('Pointer drag of fictional item onto selected host');
    for (const density of ['compact', 'balanced', 'expanded']) { await page.getByLabel('Demo density').selectOption(density); assert.equal(await page.locator('.shelf-window').getAttribute('data-density'), density); }
    result.interactions.push('All three demonstration densities');
    await page.getByRole('tab', { name: 'Transfers 2' }).focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { name: 'Clipboard optional' }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#clipboard-on').isVisible(), false);
    await page.getByRole('button', { name: 'Show sample clipboard' }).click();
    await page.getByRole('searchbox', { name: 'Search sample clipboard' }).fill('checklist');
    assert.equal(await page.locator('[data-clip]:visible').count(), 1);
    await page.locator('[data-clip="Project checklist"]').click();
    await page.getByRole('button', { name: 'Copy sample', exact: true }).click();
    assert.match(await page.locator('#clipboard-status').textContent(), /system clipboard was not changed/);
    await page.getByRole('searchbox', { name: 'Search sample clipboard' }).fill('no sample matching this');
    assert.equal(await page.locator('#clip-empty').isVisible(), true);
    result.interactions.push('Optional fictional clipboard, roving tabs, search, empty state and simulated copy');
    assert.deepEqual(result.pageErrors, []);
    assert.deepEqual(result.externalRequests, []);
    const noScript = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    await noScript.goto(base);
    assert.equal(await noScript.getByRole('heading', { name: /Give your files/ }).isVisible(), true);
    assert.equal(await noScript.getByRole('link', { name: 'View downloads' }).count(), 1);
    result.interactions.push('Product information and downloads remain available without JavaScript');
    await noScript.close();
    await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
