'use strict';
const assert = require('node:assert/strict');
const harness = require('./harness.cjs');

const calls = (page, method) => page.evaluate((name) => window.__calls.filter((call) => call.method === name).map((call) => call.value), method);

(async () => {
  const app = await harness();
  try {
    const page = await app.page('expanded', { clipboardToolsEnabled: false, entries: 4, hosts: 2 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'ShelfDock settings' });
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => {
      const show = document.querySelector('[aria-label="Show Clipboard tab"]');
      const sync = document.querySelector('[aria-label="Sync between devices"]');
      const paste = [...document.querySelectorAll('strong')].find((node) => node.textContent === 'Paste when you choose.');
      return Boolean(show && sync && paste && (show.compareDocumentPosition(sync) & Node.DOCUMENT_POSITION_FOLLOWING) && (sync.compareDocumentPosition(paste) & Node.DOCUMENT_POSITION_FOLLOWING));
    }), true, 'Sync section sits under Show Clipboard tab');

    const syncSwitch = dialog.getByRole('switch', { name: 'Sync between devices', exact: true });
    const allow = dialog.getByRole('button', { name: 'Allow pairing', exact: true });
    const pair = dialog.getByRole('button', { name: 'Pair this computer', exact: true });
    const codeInput = dialog.getByRole('textbox', { name: 'Pairing code from the other computer', exact: true });
    const machine = dialog.getByRole('combobox', { name: 'Machine', exact: true });
    const direction = dialog.getByRole('combobox', { name: 'Direction', exact: true });
    const history = dialog.getByRole('radio', { name: 'Save to clipboard history', exact: true });
    const systemClipboard = dialog.getByRole('radio', { name: 'Also place on the system clipboard', exact: true });
    const lockedNote = dialog.getByText('Turn on Clipboard tools before pairing computers.', { exact: true });
    await syncSwitch.waitFor();
    assert.equal(await syncSwitch.isVisible(), true);
    assert.equal(await syncSwitch.isDisabled(), true);
    assert.equal(await syncSwitch.getAttribute('aria-checked'), 'false');
    assert.equal(await lockedNote.isVisible(), true);
    assert.equal(await lockedNote.getAttribute('hidden'), null);
    assert.equal(await dialog.getByText('Pair ShelfDock on another computer. Copying can send text, links, and images to the devices you approve. Files stay on the transfer shelf.', { exact: true }).isVisible(), true);
    assert.equal(await dialog.getByText('Saving to clipboard history does not change what is currently copied.', { exact: true }).isVisible(), true);
    for (const control of [allow, pair, codeInput, machine, direction, history, systemClipboard]) {
      assert.equal(await control.isVisible(), true);
      assert.equal(await control.isDisabled(), true);
    }
    assert.equal(await history.isChecked(), true);
    assert.equal(await direction.inputValue(), 'both');
    assert.deepEqual(await direction.locator('option').evaluateAll((nodes) => nodes.map((node) => node.textContent)), ['Send only', 'Receive only', 'Both directions']);
    assert.deepEqual(await machine.locator('option').evaluateAll((nodes) => nodes.map((node) => node.textContent)), ['Choose a machine', 'Studio', 'Work laptop']);
    assert.equal(await dialog.getByRole('button', { name: 'Pause clipboard sync', exact: true }).count(), 0);
    assert.equal(await dialog.getByRole('button', { name: 'Resume clipboard sync', exact: true }).count(), 0);
    assert.equal(await dialog.locator('[aria-label="Pairing code"]').count(), 0);
    assert.deepEqual(page.errors, [], 'Missing clipboardSync does not crash settings');

    await dialog.getByRole('switch', { name: 'Enable Clipboard tools', exact: true }).click();
    await page.waitForFunction(() => {
      const control = document.querySelector('[aria-label="Sync between devices"]');
      return control && control.disabled === false && control.getAttribute('aria-checked') === 'false';
    });
    assert.equal(await lockedNote.count(), 0);
    assert.equal(await allow.isEnabled(), true);
    assert.equal(await codeInput.isEnabled(), true);
    assert.equal(await machine.isEnabled(), true);
    assert.equal(await direction.isEnabled(), true);
    assert.equal(await history.isEnabled(), true);
    assert.equal(await history.isChecked(), true);
    assert.equal(await pair.isDisabled(), true, 'Pairing still needs a machine and a code');
    await syncSwitch.focus();
    assert.equal(await syncSwitch.evaluate((node) => node === document.activeElement), true);

    await page.evaluate(() => {
      const publish = () => structuredClone(window.__state);
      const sync = () => {
        if (!window.__state.clipboardSync || typeof window.__state.clipboardSync !== 'object') window.__state.clipboardSync = { enabled: false, paused: false, receiveMode: 'history', peers: [] };
        if (!Array.isArray(window.__state.clipboardSync.peers)) window.__state.clipboardSync.peers = [];
        return window.__state.clipboardSync;
      };
      window.drift.updateClipboardSync = async (value) => { window.__calls.push({ method: 'updateClipboardSync', value }); Object.assign(sync(), value); return publish(); };
      window.drift.beginClipboardPairing = async () => { window.__calls.push({ method: 'beginClipboardPairing' }); sync().pairing = { code: '123456', expiresAt: '2026-09-28T09:35:00.000Z' }; return publish(); };
      window.drift.pairClipboardSync = async (value) => { window.__calls.push({ method: 'pairClipboardSync', value }); return publish(); };
      window.drift.updateClipboardPeer = async (value) => {
        window.__calls.push({ method: 'updateClipboardPeer', value });
        const current = sync();
        current.peers = current.peers.map((peer) => peer.id === value.id ? { ...peer, ...value } : peer);
        return publish();
      };
      window.drift.revokeClipboardPeer = async (value) => {
        window.__calls.push({ method: 'revokeClipboardPeer', value });
        const current = sync();
        current.peers = current.peers.filter((peer) => peer.id !== value.id);
        return publish();
      };
      window.__state.clipboardSync = { enabled: true, paused: false, receiveMode: 'history', error: 'Studio does not have a ready ShelfDock sync endpoint.', peers: [{ id: 'peer-studio', label: 'Studio', direction: 'both', paused: false, hostId: 'host-0' }] };
      window.__clips.entries[0].sourceLabel = 'Studio';
      window.__listeners.state(structuredClone(window.__state));
    });

    await page.waitForFunction(() => document.querySelector('[aria-label="Sync between devices"]')?.getAttribute('aria-checked') === 'true');
    const revoke = dialog.getByRole('button', { name: 'Revoke', exact: true });
    await revoke.waitFor();
    assert.equal(await revoke.isEnabled(), true);
    assert.equal(await dialog.getByText('Revoke stops that computer immediately. Clipboard history on this device stays here.', { exact: true }).isVisible(), true);
    assert.match(await dialog.getByRole('alert').innerText(), /Studio does not have a ready ShelfDock sync endpoint/);
    const pause = dialog.getByRole('button', { name: 'Pause clipboard sync', exact: true });
    await pause.waitFor();
    assert.equal(await pause.isEnabled(), true);
    await pause.click();
    await dialog.getByRole('button', { name: 'Resume clipboard sync', exact: true }).waitFor();
    assert.deepEqual((await calls(page, 'updateClipboardSync')).at(-1), { paused: true });

    await dialog.getByRole('combobox', { name: 'Direction for Studio', exact: true }).selectOption('send');
    await dialog.getByRole('button', { name: 'Pause sync with Studio', exact: true }).click();
    await revoke.click();
    await page.waitForFunction(() => window.__calls.some((call) => call.method === 'revokeClipboardPeer'));
    assert.deepEqual(await page.evaluate(() => window.__calls.filter((call) => call.method === 'updateClipboardPeer').map((call) => call.value)), [
      { id: 'peer-studio', direction: 'send' },
      { id: 'peer-studio', paused: true },
    ]);
    assert.deepEqual(await page.evaluate(() => window.__calls.find((call) => call.method === 'revokeClipboardPeer').value), { id: 'peer-studio' });
    assert.equal(await dialog.getByRole('button', { name: 'Revoke', exact: true }).count(), 0);

    await allow.click();
    const pairingCode = dialog.locator('[aria-label="Pairing code"]');
    await pairingCode.waitFor();
    assert.equal((await pairingCode.innerText()).trim(), '123456');
    assert.equal(await dialog.locator('.clipboard-sync-expiry time').getAttribute('dateTime'), '2026-09-28T09:35:00.000Z');
    await machine.selectOption('host-0');
    await codeInput.fill('654321');
    await direction.selectOption('receive');
    await pair.click();
    await page.waitForFunction(() => window.__calls.some((call) => call.method === 'pairClipboardSync'));
    assert.deepEqual(await page.evaluate(() => window.__calls.find((call) => call.method === 'pairClipboardSync').value), { hostId: 'host-0', code: '654321', direction: 'receive' });

    await history.focus();
    await history.press('ArrowDown');
    await page.waitForFunction(() => window.__calls.some((call) => call.method === 'updateClipboardSync' && call.value && call.value.receiveMode === 'clipboard'));
    assert.equal(await systemClipboard.isChecked(), true);
    await syncSwitch.focus();
    await syncSwitch.press('Space');
    await page.waitForFunction(() => window.__calls.some((call) => call.method === 'updateClipboardSync' && call.value && call.value.enabled === false));
    assert.equal(await page.locator('.toast').count(), 0, 'Sync actions do not raise success toasts');
    assert.deepEqual(page.errors, []);

    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Clipboard', exact: true }).click();
    await page.locator('.clipboard-list [role="option"]').first().waitFor();
    await page.locator('.clipboard-source').waitFor();
    assert.equal(await page.locator('.clipboard-source').count(), 1);
    assert.equal((await page.locator('.clipboard-source').innerText()).trim(), 'From Studio');
    const sourceRow = page.locator('.clipboard-entry').filter({ has: page.locator('.clipboard-source') });
    const sourceName = await sourceRow.getAttribute('aria-label');
    assert.match(sourceName, /Project handoff notes/);
    assert.notEqual(sourceName, 'From Studio');
    assert.equal(await page.locator('.clipboard-entry').nth(1).locator('.clipboard-source').count(), 0);
    assert.deepEqual(page.errors, []);
    console.log('Clipboard sync: disabled until tools are on, settings controls reachable by name, revoke for a seeded peer, From Studio on the history row.');
    await page.close();
  } finally { await app.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
