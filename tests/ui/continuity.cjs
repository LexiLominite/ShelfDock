'use strict';
const assert = require('node:assert/strict');
const harness = require('./harness.cjs');
(async () => {
 const app = await harness();
 try {
  const page = await app.page('expanded', { clipboardToolsEnabled: false, hosts: 2 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'ShelfDock settings' });
  const continuity = dialog.getByRole('switch', { name: 'Continuity clipboard', exact: true });
  const advanced = dialog.locator('.clipboard-sync-advanced');
  const manual = dialog.getByRole('switch', { name: 'Sync between devices', exact: true });
  assert.equal(await continuity.getAttribute('aria-checked'), 'false', 'Legacy snapshots do not opt in');
  assert.equal(await continuity.isDisabled(), true);
  assert.equal(await advanced.getAttribute('open'), null, 'Advanced starts closed');
  assert.equal(await manual.isVisible(), false);
  assert.equal(await page.getByRole('button', { name: 'Clipboard', exact: true }).count(), 0);
  assert.match(await dialog.innerText(), /Copy here, then paste on another linked device/);
  await page.evaluate(() => {
    const publish = () => structuredClone(window.__state);
    const sync = () => window.__state.clipboardSync ||= { available: true, enabled: false, paused: false, receiveMode: 'history', peers: [], excludedPeers: [] };
    window.drift.updateClipboardSync = async (value) => {
      window.__calls.push({ method: 'updateClipboardSync', value });
      const current = sync();
      if (value.continuity === true) { current.manualReceiveMode = current.receiveMode; Object.assign(current, { continuity: true, enabled: true, paused: false, receiveMode: 'clipboard' }); }
      if (value.continuity === false) { current.receiveMode = current.manualReceiveMode; current.continuity = false; }
      Object.assign(current, value);
      return publish();
    };
    window.drift.restoreClipboardPeer = async (value) => { window.__calls.push({ method: 'restoreClipboardPeer', value }); sync().excludedPeers = sync().excludedPeers.filter((peer) => peer.id !== value.id); return publish(); };
  });
  const mutations = () => page.evaluate(() => window.__calls.filter((call) => ['pairOwnedClipboardSync', 'updateClipboardSync', 'restoreClipboardPeer'].includes(call.method)));
  assert.deepEqual(await mutations(), [], 'Opening settings does not start networking');
  await dialog.getByRole('switch', { name: 'Enable Clipboard tools', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Continuity clipboard"]').disabled);
  assert.equal(await continuity.getAttribute('aria-checked'), 'false');
  assert.deepEqual(await mutations(), [], 'Tools alone do not enable continuity');
  await continuity.focus(); await continuity.press('Space');
  await page.waitForFunction(() => document.querySelector('[aria-label="Continuity clipboard"]').getAttribute('aria-checked') === 'true');
  assert.deepEqual(await mutations(), [{ method: 'updateClipboardSync', value: { continuity: true } }], 'One explicit atomic opt-in patch');
  await dialog.getByRole('status').filter({ hasText: '0 devices connected.' }).waitFor();
  assert.equal(await manual.isVisible(), false, 'No per-device Connect needed');
  await page.evaluate(() => {
   window.__state.clipboardSync.peers = [{ id: 'linked-id', label: 'Studio', status: 'connected', direction: 'receive', paused: false }];
   window.__state.clipboardContinuity = { running: true, devices: [{ hostId: 'host-0', label: 'Studio', status: 'connected' }, { hostId: 'host-1', label: 'Work laptop', status: 'waiting', detail: 'Open the app and enable Continuity clipboard.' }] };
   window.__listeners.state(structuredClone(window.__state));
  });
  await dialog.getByRole('status').filter({ hasText: '1 device connected.' }).waitFor();
  assert.equal(await dialog.locator('.clipboard-continuity-devices li').count(), 2);
  assert.match(await dialog.locator('.clipboard-continuity-devices').innerText(), /Waiting for app and sync/);
  assert.equal(await page.locator('.modal-backdrop .spinning').count(), 0);
  await dialog.getByRole('button', { name: 'Pause Continuity clipboard', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: 'Continuity clipboard is paused.' }).waitFor();
  await dialog.getByRole('button', { name: 'Resume Continuity clipboard', exact: true }).click();
  await continuity.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Continuity clipboard"]').getAttribute('aria-checked') === 'false');
  await dialog.getByText('Advanced clipboard sync', { exact: true }).click();
  assert.equal(await manual.getAttribute('aria-checked'), 'true', 'Manual enabled state is retained');
  assert.equal(await dialog.getByRole('radio', { name: 'Save to clipboard history', exact: true }).isChecked(), true, 'Manual receive preference is restored');
  assert.equal(await dialog.getByRole('combobox', { name: 'Direction for Studio', exact: true }).inputValue(), 'receive');
  const beforeSelection = await mutations();
  await dialog.getByRole('combobox', { name: 'Machine', exact: true }).selectOption('host-1');
  assert.deepEqual(await mutations(), beforeSelection, 'Advanced selection performs no network action');
  await page.evaluate(() => {
   window.__state.clipboardSync.excludedPeers = [{ id: 'removed-stable-1', label: 'Same name' }, { id: 'removed-stable-2', label: 'Same name' }];
   window.__listeners.state(structuredClone(window.__state));
  });
  await dialog.getByRole('button', { name: 'Allow Same name again', exact: true }).first().click();
  assert.deepEqual((await mutations()).at(-1), { method: 'restoreClipboardPeer', value: { id: 'removed-stable-1' } });
  assert.equal(await dialog.getByRole('button', { name: 'Allow Same name again', exact: true }).count(), 1, 'Restore uses stable identity rather than label');
  await continuity.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Continuity clipboard"]').getAttribute('aria-checked') === 'true');
  await page.evaluate(() => {
    const original = window.drift.updateClipboardTools;
    window.drift.updateClipboardTools = async (value) => {
      const result = await original(value);
      if (value.enabled === false) {
        window.__state.clipboardSync.enabled = false;
        window.__state.clipboardContinuity = { running: false, devices: [] };
        return structuredClone(window.__state);
      }
      return result;
    };
  });
  await dialog.getByRole('switch', { name: 'Enable Clipboard tools', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Continuity clipboard"]').disabled);
  assert.equal(await continuity.isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: 'Allow Same name again', exact: true }).isDisabled(), true);
  assert.equal(await continuity.getAttribute('aria-checked'), 'true', 'Tools-off retains continuity consent');
  const beforeToolsResume = await mutations();
  await dialog.getByRole('switch', { name: 'Enable Clipboard tools', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Continuity clipboard"]').disabled);
  await dialog.getByRole('status').filter({ hasText: 'Continuity clipboard is stopped.' }).waitFor();
  assert.deepEqual(await mutations(), beforeToolsResume, 'Re-enabling tools alone does not restart continuity');
  await dialog.getByRole('button', { name: 'Resume Continuity clipboard', exact: true }).click();
  assert.deepEqual((await mutations()).at(-1), { method: 'updateClipboardSync', value: { continuity: true } }, 'Explicit Resume atomically restores continuity');
  await dialog.getByRole('button', { name: 'Pause Continuity clipboard', exact: true }).waitFor();
  assert.deepEqual(page.errors, []);
  console.log('Continuity UI: legacy/default off, tools gating, explicit atomic opt-in, quiet multi-device status, pause/disable, closed manual Advanced, prior receive choice and stable exclusions restore; no passive connection.');
 } finally { await app.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
