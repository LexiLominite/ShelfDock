'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const harness = require('./harness.cjs');

(async () => {
  const app = await harness();
  const output = path.resolve(__dirname, '../../docs/received');
  await fs.mkdir(output, { recursive: true });
  try {
    for (const [mode, label] of [['compact', 'compact'], ['expanded', 'balanced'], ['large', 'expanded']]) {
      const page = await app.page(mode, { clipboardToolsEnabled: false });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await page.getByRole('button', { name: 'Clipboard', exact: true }).count(), 0);
      const tab = page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: /^Received/ });
      await tab.click();
      await page.getByRole('region', { name: 'Received and sent files' }).waitFor();
      assert.equal(await tab.getAttribute('aria-current'), 'page');
      assert.equal(await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: /^Transfers/ }).getAttribute('aria-current'), null);
      assert.equal(await page.locator('.received-detail').count(), 0, 'Every density keeps arrival details collapsed');
      await page.getByRole('button', { name: 'Received Handoff notes.txt + 1', exact: true }).click();
      await page.getByRole('button', { name: 'Open folder', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__calls.filter(call => call.method === 'openReceivedFolder').length), 1);
      const search = page.getByRole('textbox', { name: 'Search received and sent files' });
      await search.fill('Work laptop');
      assert.equal(await page.locator('.received-record').count(), 1);
      await search.fill('no such file');
      await page.getByText('No matching transfers').waitFor();
      await page.getByRole('button', { name: 'Clear transfer search' }).click();
      await page.screenshot({ path: path.join(output, `${label}-received.png`) });
      await page.getByRole('checkbox', { name: 'Sketch.png' }).uncheck();
      await page.getByRole('button', { name: 'To shelf · 1', exact: true }).click();
      await page.getByRole('region', { name: 'File and text shelf' }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__calls.filter(call => call.method === 'addReceivedToShelf').at(-1).value), { id: 'arrival-1', names: ['Handoff notes.txt'] });
      assert.equal(await page.evaluate(() => window.__calls.some(call => ['send', 'sendMany'].includes(call.method))), false, 'Putting received files on the shelf never sends');
      await tab.click();
      await page.getByRole('button', { name: 'Mark all seen', exact: true }).click();
      assert.equal(await tab.locator('span').count(), 0, 'Seen arrivals clear their badge');
      await page.getByRole('group', { name: 'Transfer history filter' }).getByRole('button', { name: 'Sent', exact: true }).click();
      await page.getByRole('button', { name: 'Sent Release notes.txt', exact: true }).click();
      await page.getByRole('button', { name: 'Use 1 shelf item', exact: true }).click();
      await page.getByRole('region', { name: 'File and text shelf' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Deselect Release notes.txt', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => window.__calls.some(call => ['send', 'sendMany'].includes(call.method))), false);
      assert.deepEqual(page.errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal overflow');
      await page.close();
    }
    const page = await app.page('expanded');
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Clipboard', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('switch', { name: 'Enable Clipboard tools', exact: true }).click();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('region', { name: 'File and text shelf' }).waitFor();
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: /^Received/ }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('textbox', { name: 'This device’s name' }).fill('Work notebook');
    await page.getByRole('button', { name: 'Save name' }).click();
    assert.equal(await page.evaluate(() => window.__state.settings.deviceName), 'Work notebook');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('region', { name: 'Received and sent files' }).waitFor();
    await page.close();
    console.log('Received: all densities, Clipboard-off access, collapsed details, search, folder action, selected-item handoff, sent reuse, unread badge, no accidental send, and device naming.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
