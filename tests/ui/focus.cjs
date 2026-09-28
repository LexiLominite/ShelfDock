'use strict';
const assert = require('node:assert/strict');
const harness = require('./harness.cjs');

(async () => {
  const app = await harness();
  try {
    const page = await app.page('expanded');
    const card = page.locator('[data-host-id="host-0"]');
    await card.getByRole('button', { name: 'Connections for Studio', exact: true }).click();
    await page.getByRole('menuitem', { name: /Active & saved forwards/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Port forwarding', exact: true });
    await dialog.getByRole('button', { name: 'New forward', exact: true }).click();
    await dialog.getByRole('button', { name: 'Advanced', exact: true }).click();
    const details = dialog.locator('details.quick-notes');
    const summary = details.locator('summary');
    const note = details.locator('input');
    const close = dialog.getByRole('button', { name: 'Close dialog', exact: true });
    assert.equal(await details.getAttribute('open'), null);
    assert.equal(await note.isVisible(), false, 'The final note input is hidden while its disclosure is closed');
    await summary.focus();
    await page.keyboard.press('Tab');
    assert.equal(await close.evaluate(element => element === document.activeElement), true, 'Tab from the last visible summary wraps to the dialog close button');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await summary.evaluate(element => element === document.activeElement), true, 'Reverse Tab wraps to the visible summary, not its hidden input');
    await page.keyboard.press('Enter');
    assert.equal(await note.isVisible(), true);
    await page.keyboard.press('Tab');
    assert.equal(await note.evaluate(element => element === document.activeElement), true, 'Opening Notes makes its field a keyboard stop');
    await page.keyboard.press('Tab');
    assert.equal(await close.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await note.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.evaluate(() => window.__calls.filter(call => call.method === 'hideWindow').length), 0, 'Escape closes the dialog without hiding the native app');
    assert.equal(await page.evaluate(() => window.__calls.filter(call => ['startTunnel', 'restartTunnel'].includes(call.method)).length), 0, 'Keyboard review never starts a connection');
    assert.deepEqual(page.errors, []);
    await page.close();
    console.log('Dialog focus UI passed: closed Notes summary loops, hidden input skipped, opened Notes field included, Escape closes without hiding.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
