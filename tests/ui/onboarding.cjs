'use strict';
const assert = require('node:assert/strict');
const harness = require('./harness.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const KEY = 'lex-drift.onboarding.v1';
const forbidden = ['updateClipboardTools', 'updateSettings', 'send', 'sendMany', 'probeHosts', 'configureAccess', 'forgetPassword', 'installOnMac', 'previewMacInstall', 'captureClipboard', 'captureClipboardHistory', 'hideWindow', 'quit', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'updateUpdatePreferences', 'startTunnel', 'restartTunnel', 'stopTunnel', 'openTunnelSite', 'refreshHosts', 'pickFiles', 'exportConfig', 'importConfig', 'openSettingsFolder', 'saveHost', 'removeHost', 'enqueueText', 'enqueueFiles', 'clearItems', 'undoClear', 'previewRemoteInstall', 'installRemotely', 'inspectRemoteDesktop', 'previewRemoteDesktopSetup', 'applyRemoteDesktopSetup', 'startRemoteDesktop', 'updateClipboardSync', 'beginClipboardPairing', 'pairClipboardDevice', 'pairOwnedClipboardSync'];
const topics = ['Show and hide', 'Shelf and undo', 'Machines, LAN, and Tailscale', 'Passwords and SSH keys', 'Several items and machines', 'Received and sent', 'Clipboard, recording, and hiding', 'Clipboard sync', 'Open a remote service', 'Display density', 'Import and export', 'Remote screen', 'Updates and restart', 'Install on another device'];

function options(extra = {}) {
  return { onboarding: 'fresh', clipboardToolsEnabled: false, clipboardTabVisible: false, productName: 'LexBridge', ...extra };
}
async function boot(app, mode = 'expanded', extra = {}) {
  const page = await app.page(mode, extra);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  return page;
}
async function progressText(dialog) {
  return dialog.locator('#onboarding-progress').innerText();
}
async function addedCalls(page, start) {
  return page.evaluate((index) => window.__calls.slice(index).map((call) => call.method), start);
}
function assertAllowed(calls) {
  for (const method of calls) assert.equal(forbidden.includes(method), false, method);
}
async function clipboardTools(page) {
  return page.evaluate(() => window.__state.clipboardTools);
}
async function assertInViewport(page, locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box, 'expected an on-screen box');
  assert.ok(box.x >= -1 && box.y >= -1, `origin ${box.x},${box.y}`);
  assert.ok(box.x + box.width <= viewport.width + 1, `right edge ${box.x + box.width}`);
  assert.ok(box.y + box.height <= viewport.height + 1, `bottom edge ${box.y + box.height}`);
}

(async () => {
  const app = await harness();
  try {
    const settled = await boot(app, 'expanded', { clipboardToolsEnabled: false, clipboardTabVisible: false });
    await settled.waitForFunction(() => window.__calls.some((call) => call.method === 'setInteraction'));
    assert.equal(await settled.locator('[role="dialog"]').count(), 0, 'completed tutorial stays closed');
    assert.match(await settled.evaluate((key) => localStorage.getItem(key), KEY), /"status":"completed"/);
    assert.deepEqual(await clipboardTools(settled), { enabled: false, showTab: false, historyEnabled: false });
    assert.equal(await settled.evaluate(() => window.__calls.some((call) => call.method === 'updateClipboardTools' || call.method === 'hideWindow')), false);
    assert.deepEqual(settled.errors, []);
    await settled.close();

    const skipped = await boot(app, 'expanded', options());
    const quickStart = skipped.getByRole('dialog', { name: 'LexBridge quick start' });
    await quickStart.waitFor();
    assert.equal(await progressText(quickStart), 'Step 1 of 4');
    await quickStart.locator('li').filter({ hasText: 'deliberate shake' }).waitFor();
    await quickStart.locator('li').filter({ hasText: 'Or press' }).waitFor();
    await quickStart.locator('li').filter({ hasText: 'Use Tab' }).waitFor();
    assert.equal(await quickStart.getByRole('button', { name: 'Install on another device', exact: true }).count(), 0);
    await skipped.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
    await skipped.waitForFunction(() => window.__calls.filter((call) => call.method === 'setInteraction').at(-1)?.value?.editing === true);
    const evidenceDir = path.resolve(__dirname, '../../../../work/final-qa');
    await fs.mkdir(evidenceDir, { recursive: true });
    await skipped.screenshot({ path: path.join(evidenceDir, 'tutorial-quick-start.png') });
    const beforePaste = await skipped.evaluate(() => window.__calls.length);
    await skipped.keyboard.press('Control+V');
    await skipped.evaluate(() => {
      const tray = document.querySelector('.drop-tray');
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'Quick note from the shelf');
      tray.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    assertAllowed(await addedCalls(skipped, beforePaste));
    assert.equal(await skipped.evaluate(() => window.__state.items.length), 2);
    for (let count = 0; count < 8; count += 1) {
      await skipped.keyboard.press('Tab');
      assert.equal(await skipped.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement)), true);
    }
    await skipped.keyboard.press('Shift+Tab');
    assert.equal(await skipped.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement)), true);
    await skipped.keyboard.press('Escape');
    await skipped.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    assert.equal(await skipped.evaluate(() => window.__calls.some((call) => call.method === 'hideWindow')), false);
    await skipped.locator('.brand').getByText('LexBridge').waitFor();
    assert.match(await skipped.evaluate((key) => localStorage.getItem(key), KEY), /"status":"skipped"/);
    await skipped.reload();
    await skipped.getByRole('button', { name: /^Select Studio,/ }).waitFor();
    await skipped.waitForFunction(() => window.__calls.some((call) => call.method === 'setInteraction'));
    assert.equal(await skipped.locator('[role="dialog"]').count(), 0);
    assert.deepEqual(await clipboardTools(skipped), { enabled: false, showTab: false, historyEnabled: false });
    assert.deepEqual(skipped.errors, []);
    await skipped.close();

    const tour = await boot(app, 'expanded', options());
    const dialog = tour.getByRole('dialog', { name: 'LexBridge quick start' });
    await dialog.waitFor();
    const start = await tour.evaluate(() => window.__calls.length);
    await tour.getByRole('button', { name: 'Next', exact: true }).click();
    assert.equal(await progressText(dialog), 'Step 2 of 4');
    await dialog.locator('li').filter({ hasText: 'Add text for a note' }).waitFor();
    await dialog.locator('li').filter({ hasText: 'does not send them' }).waitFor();
    await tour.getByRole('button', { name: 'Back', exact: true }).click();
    assert.equal(await progressText(dialog), 'Step 1 of 4');
    await tour.getByRole('button', { name: 'Next', exact: true }).click();
    await tour.getByRole('button', { name: 'Next', exact: true }).click();
    assert.equal(await progressText(dialog), 'Step 3 of 4');
    await dialog.locator('li').filter({ hasText: /machine never sends/i }).waitFor();
    await dialog.getByText('sends immediately', { exact: true }).waitFor();
    await tour.getByRole('button', { name: 'Next', exact: true }).click();
    assert.equal(await progressText(dialog), 'Step 4 of 4');
    assert.equal(await tour.getByRole('button', { name: 'Next', exact: true }).count(), 0);
    await tour.getByRole('button', { name: 'Feature guide', exact: true }).click();
    await tour.getByRole('dialog', { name: 'LexBridge feature guide' }).waitFor();
    for (const topic of topics) await tour.getByRole('button', { name: topic, exact: true }).waitFor();
    await tour.getByRole('button', { name: 'Shelf and undo', exact: true }).click();
    assert.match(await tour.getByRole('region', { name: 'Shelf and undo' }).innerText(), /Undo/i);
    await tour.getByRole('button', { name: 'Received and sent', exact: true }).click();
    await tour.getByRole('button', { name: 'Show activity', exact: true }).click();
    assert.equal(await tour.getByRole('button', { name: /^Activity/ }).getAttribute('aria-expanded'), 'true');
    assert.equal(await tour.locator('[role="dialog"]').count(), 0, 'guide navigation reveals the chosen workspace');
    await tour.getByRole('button', { name: 'Settings', exact: true }).click();
    await tour.getByRole('button', { name: 'Open feature guide', exact: true }).click();
    await tour.getByRole('button', { name: 'Clipboard, recording, and hiding', exact: true }).click();
    await tour.getByRole('button', { name: 'Review clipboard in Settings', exact: true }).click();
    const settings = tour.getByRole('dialog', { name: 'LexBridge settings' });
    await settings.waitFor();
    assert.equal(await settings.getByRole('switch', { name: 'Enable Clipboard tools' }).getAttribute('aria-checked'), 'false');
    assert.equal(await settings.getByRole('switch', { name: 'Show Clipboard tab' }).getAttribute('aria-checked'), 'false');
    assert.equal(await tour.getByRole('button', { name: 'Clipboard', exact: true }).count(), 0);
    await settings.getByRole('button', { name: 'Replay quick start', exact: true }).click();
    await tour.getByRole('dialog', { name: 'LexBridge quick start' }).waitFor();
    assert.equal(await progressText(tour.getByRole('dialog', { name: 'LexBridge quick start' })), 'Step 1 of 4');
    for (let count = 0; count < 3; count += 1) await tour.getByRole('button', { name: 'Next', exact: true }).click();
    await tour.getByRole('button', { name: 'Finish', exact: true }).click();
    await tour.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    assert.match(await tour.evaluate((key) => localStorage.getItem(key), KEY), /"status":"completed"/);
    assert.deepEqual(await clipboardTools(tour), { enabled: false, showTab: false, historyEnabled: false });
    const settingsState = await tour.evaluate(() => window.__state.settings);
    assert.equal(settingsState.shakeEnabled, true);
    assert.equal(settingsState.sensitivity, 'strong');
    assert.equal(settingsState.viewMode, 'expanded');
    assert.equal(Object.hasOwn(settingsState, 'onboarding'), false);
    assert.equal(await tour.evaluate(() => window.__state.items.length), 2);
    assertAllowed(await addedCalls(tour, start));
    await tour.getByRole('button', { name: 'Settings', exact: true }).click();
    await tour.getByRole('button', { name: 'Open feature guide', exact: true }).click();
    await tour.getByRole('dialog', { name: 'LexBridge feature guide' }).waitFor();
    await tour.getByRole('button', { name: 'Install on another device', exact: true }).click();
    assert.match(await tour.getByRole('region', { name: 'Install on another device' }).innerText(), /More menu/);
    await tour.getByRole('button', { name: 'Updates and restart', exact: true }).click();
    assert.match(await tour.getByRole('region', { name: 'Updates and restart' }).innerText(), /explicitly choose/);
    await tour.keyboard.press('Escape');
    await tour.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    assert.equal(await tour.evaluate(() => window.__calls.some((call) => call.method === 'hideWindow')), false);
    await tour.locator('.brand').getByText('LexBridge').waitFor();
    assert.match(await tour.evaluate((key) => localStorage.getItem(key), KEY), /"status":"skipped"/);
    assert.deepEqual(tour.errors, []);
    await tour.close();

    for (const mode of ['compact', 'expanded', 'large']) {
      const page = await boot(app, mode, options({ productName: 'ShelfDock' }));
      const guide = page.getByRole('dialog', { name: 'ShelfDock quick start' });
      await guide.waitFor();
      await page.locator(`.app.view-${mode}`).waitFor();
      assert.equal(await progressText(guide), 'Step 1 of 4');
      await assertInViewport(page, guide);
      await assertInViewport(page, page.getByRole('button', { name: 'Skip', exact: true }));
      await assertInViewport(page, page.getByRole('button', { name: 'Next', exact: true }));
      assert.equal(await page.getByRole('button', { name: 'Clipboard', exact: true }).count(), 0);
      assert.deepEqual(await clipboardTools(page), { enabled: false, showTab: false, historyEnabled: false });
      assert.equal(await page.evaluate(() => window.__state.settings.viewMode), mode);
      if (mode === 'compact') await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
      else await page.getByRole('button', { name: 'Skip', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      assert.equal(await page.evaluate(() => window.__calls.some((call) => call.method === 'hideWindow' || call.method === 'updateClipboardTools' || call.method === 'updateSettings')), false);
      assert.match(await page.evaluate((key) => localStorage.getItem(key), KEY), /"status":"skipped"/);
      assert.deepEqual(page.errors, []);
      await page.close();
    }
    console.log('Onboarding: fresh quick start, no side effects, skip persistence, starter steps, settings replay, feature guide, focus, Escape, three viewports, product name, clipboard consent.');
  } finally { await app.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
