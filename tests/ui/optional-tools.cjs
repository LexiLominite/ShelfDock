'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const harness = require('./harness.cjs');
(async () => {
  const app = await harness();
  const output = path.resolve(__dirname, '../../docs/optional-tools');
  await fs.mkdir(output, {recursive: true});
  try {
    for (const [mode, label] of [['compact','compact'], ['expanded','balanced'], ['large','expanded']]) {
      const page = await app.page(mode, {clipboardToolsEnabled: false});
      await page.emulateMedia({reducedMotion: 'reduce'});
      assert.equal(await page.getByRole('button', {name: 'Clipboard', exact: true}).count(), 0);
      assert.equal(await page.locator('.machine-activity').count(), 0);
      await page.screenshot({path: path.join(output, `${label}-default.png`)});
      await page.locator('[data-host-id="host-0"]').hover();
      await page.getByRole('button', {name: 'Open site on Studio', exact: true}).click();
      const form = page.getByRole('form', {name: 'Connect to a website through Studio'});
      assert.equal(await form.locator('.quick-connect-heading strong').innerText(), 'Remote service');
      await form.getByLabel('Website address', {exact: true}).fill('http://localhost:1331');
      assert.equal(await form.getByRole('button', {name: 'Advanced', exact: true}).getAttribute('aria-expanded'), 'false');
      await page.screenshot({path: path.join(output, `${label}-remote-service.png`)});
      await page.keyboard.press('Escape');
      await page.getByRole('button', {name: /^Select Studio,/}).focus();
      await page.keyboard.press('Shift+F10');
      const menu = page.getByRole('menu', {name: 'Machine connections'});
      const bounds = await menu.boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= page.viewportSize().height, 'Machine menu fits viewport');
      await page.screenshot({path: path.join(output, `${label}-menu.png`)});
      const item = page.getByRole('menuitem', {name: 'Install on this device…', exact: true});
      await item.focus(); await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', {name: 'Install on this device', exact: true});
      await dialog.waitFor();
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
      assert.equal(await page.getByLabel('Device to install on').inputValue(), 'host-0');
      await page.getByText(/Installation currently supports Macs only/).waitFor();
      assert.equal(await page.evaluate(() => window.__calls.filter(c => c.method === 'previewMacInstall' || c.method === 'installOnMac').length), 0, 'Opening installer never probes or installs');
      await page.screenshot({path: path.join(output, `${label}-install.png`)});
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]') && document.activeElement?.closest('[data-host-id]')?.getAttribute('data-host-id') === 'host-0', null, {timeout: 2000});
      assert.deepEqual(page.errors, []); await page.close();
    }
    console.log('Optional tools: hidden Clipboard defaults, remote-service label, collapsed details, keyboard installer entry, selected destination, no automatic remote operations, menu bounds and screenshots across all three densities.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
