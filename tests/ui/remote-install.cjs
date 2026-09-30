'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const harness = require('./harness.cjs');
const count = (page, method) => page.evaluate(m => window.__calls.filter(call => call.method === m).length, method);

(async () => {
  const app = await harness();
  try {
    const page = await app.page('expanded');
    
    // Open Remote Install for a host
    const card = page.locator('[data-host-id="host-0"]');
    await card.locator('.machine-main').focus();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menu', { name: 'Machine connections' }).waitFor();
    await page.getByRole('menuitem', { name: /Install on this device/ }).click();
    
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    
    await page.getByRole('button', { name: 'Check Machine' }).click();
    assert.equal(await count(page, 'previewRemoteInstall'), 1);
    
    // Wait for the review screen
    await page.getByText('Review destination').waitFor();
    
    // Install
    await page.getByRole('button', { name: /Install on/ }).click();
    assert.equal(await count(page, 'installRemotely'), 1);
    
    // Mock should simulate progress, then finish
    await page.evaluate(() => window.__finishRemoteInstall('installed'));
    
    await page.getByText('Installed on Studio').waitFor();
    await page.getByRole('button', { name: 'Done' }).click();
    
    await page.waitForFunction(() => !document.querySelector('.remote-install-panel'));
    
    // A slow compatibility probe can be cancelled before it returns a plan.
    await page.evaluate(() => {
      const original = window.drift.previewRemoteInstall;
      window.drift.previewRemoteInstall = request => new Promise(resolve => {
        window.__finishSlowPreview = () => resolve(original(request));
      });
    });
    await card.locator('.machine-main').focus(); await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: /Install on this device/ }).click();
    await page.getByRole('button', { name: 'Check Machine' }).click();
    await page.getByRole('button', { name: 'Cancel check' }).click();
    await page.waitForFunction(() => !document.querySelector('.remote-install-panel'));
    assert.equal(await count(page, 'cancelRemoteInstall'), 1);
    await page.evaluate(() => window.__finishSlowPreview());
    await page.waitForTimeout(30);
    assert.equal(await page.locator('.remote-install-panel').count(), 0);
    assert.equal(await count(page, 'installRemotely'), 1);
    await card.locator('.machine-main').focus(); await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: /Install on this device/ }).click();
    assert.equal(await page.getByRole('button', { name: 'Check Machine' }).isEnabled(), true);
    assert.equal(await page.getByText('Review destination').count(), 0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(page.errors, []);
    console.log('Remote Install UI passed, including cancellation of an unresolved preview.');
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
