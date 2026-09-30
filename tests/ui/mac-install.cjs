'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const harness = require('./harness.cjs');

(async () => {
  const app = await harness();
  const open = async page => {
    await page.locator('[data-host-id="host-0"]').hover();
    await page.getByRole('button', {name: 'Connections for Studio', exact: true}).click();
    await page.getByRole('menuitem', {name: 'Install on this device…', exact: true}).click();
    assert.equal(await page.getByLabel('Device to install on').inputValue(), 'host-0');
    assert.equal(await page.getByLabel('Device to install on').isDisabled(), true);
    await page.getByText(/Remote installation works for Mac, Windows x64 and Linux/).waitFor();
    assert.equal(await page.evaluate(() => window.__calls.filter(c => ['previewRemoteInstall', 'installRemotely', 'previewMacInstall', 'installOnMac'].includes(c.method)).length), 0, 'Opening the installer has no probe or install effects');
  };
  const preview = async page => {
    await page.getByRole('button', {name: 'Check Machine', exact: true}).click();
    await page.getByRole('heading', {name: 'Review destination'}).waitFor();
  };
  try {
    for (const mode of ['compact', 'expanded', 'large']) {
      const page = await app.page(mode, {remoteTargetOS: 'macos', personalPreset: true, clipboardToolsEnabled: false});
      assert.equal(await page.getByRole('button', {name: 'Clipboard', exact: true}).count(), 0);
      await page.getByRole('button', {name: 'Settings', exact: true}).click();
      assert.equal(await page.getByRole('button', {name: /Install on/}).count(), 0);
      await page.getByRole('button', {name: 'Close dialog', exact: true}).click();
      await open(page); await preview(page);
      const review = page.getByRole('region', {name: 'Installation destination'});
      assert.ok((await review.innerText()).includes('demo@machine-0.example.test'));
      assert.ok((await review.innerText()).includes('/Users/demo/Applications/ShelfDock.app'));
      assert.equal(await page.evaluate(() => window.__calls.filter(c => c.method === 'installRemotely').length), 0, 'preview cannot install');
      const install = page.getByRole('button', {name: 'Install on Studio', exact: true});
      assert.equal(await install.isDisabled(), true, 'personal preset needs explicit consent');
      await page.getByRole('checkbox', {name: /bundled personal machine preset/}).check();
      if (mode === 'expanded') await page.screenshot({path: path.resolve(__dirname, '../../docs/palette/install-mac-review.png')});
      await install.click();
      await page.locator('.remote-install-progress strong').filter({hasText: /^Preparing app…$/}).waitFor();
      assert.equal(await page.getByRole('button', {name: 'Close dialog', exact: true}).isDisabled(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(), 1, 'copy cannot be dismissed by an accidental Escape');
      const calls = await page.evaluate(() => window.__calls.filter(c => c.method === 'installRemotely'));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].value.consentPersonalPreset, true);
      await page.evaluate(() => window.__finishRemoteInstall());
      await page.getByText('Installed on Studio', {exact: true}).waitFor();
      await page.getByRole('button', {name: 'Done', exact: true}).click();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.deepEqual(page.errors, []); await page.close();
    }
    for (const platform of ['win32', 'linux']) {
      const page = await app.page('expanded', {platform});
      await page.getByRole('button', {name: 'Connections for Studio', exact: true}).click();
      assert.equal(await page.getByRole('menuitem', {name: 'Install on this device…'}).count(), 1, 'Generic installation is available on every local platform');
      await page.keyboard.press('Escape');
      await page.getByRole('button', {name: 'Settings', exact: true}).click();
      assert.equal(await page.getByRole('switch', {name: 'Enable Clipboard tools'}).count(), 1);
      await page.close();
    }
    const page = await app.page('expanded', {remoteTargetOS: 'macos'}); await open(page);
    await page.evaluate(() => { window.__macExisting = true; }); await preview(page);
    assert.equal(await page.getByRole('button', {name: 'Install on Studio'}).isDisabled(), true);
    await page.getByRole('button', {name: 'Back', exact: true}).click();
    await page.evaluate(() => { window.__macExisting = false; window.__macPreviewError = 'This destination is not a Mac.'; });
    await page.getByRole('button', {name: 'Check Machine', exact: true}).click();
    await page.getByRole('alert').filter({hasText: 'not a Mac'}).waitFor();
    await page.evaluate(() => { window.__macPreviewError = ''; }); await preview(page);
    await page.evaluate(() => { window.__state.hosts[0].address = 'changed.example.test'; window.__listeners.state?.(structuredClone(window.__state)); });
    await page.getByRole('alert').filter({hasText: 'machine changed'}).waitFor();
    assert.equal(await page.getByRole('button', {name: 'Install on Studio'}).count(), 0);
    for (const [key, value] of [['user', 'other-demo'], ['port', 2222], ['sshAlias', 'changed-alias'], ['identityFile', '/fictional/other-key'], ['os', 'windows']]) {
      await preview(page);
      await page.evaluate(({key, value}) => { window.__state.hosts[0][key] = value; window.__listeners.state?.(structuredClone(window.__state)); }, {key, value});
      await page.getByRole('alert').filter({hasText: 'machine changed'}).waitFor();
      assert.equal(await page.getByRole('button', {name: 'Install on Studio'}).count(), 0, `${key} change invalidates reviewed destination`);
    }
    await preview(page); await page.getByRole('button', {name: 'Install on Studio'}).click();
    await page.waitForFunction(() => !!window.__finishRemoteInstall);
    await page.evaluate(() => window.__finishRemoteInstall('failed'));
    await page.getByRole('alert').filter({hasText: 'Upload could not be verified'}).waitFor();
    assert.equal(await page.getByRole('button', {name: 'Check Machine', exact: true}).isEnabled(), true);
    assert.deepEqual(page.errors, []); await page.close();
    console.log('Generic installer Mac destination UI: destination review, personal-preset consent, single install, busy guard and completion in three densities; Windows/Linux entry; existing app, OS failure, stale destination and failed upload. All fixture-only, no remote deployment.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
