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
    assert.equal(await dialog.getByText('Keep both ShelfDock apps open while pairing. The computer entering the code needs SSH key access to the selected saved machine. While sync is on, supported text, links, and images can be sent to approved devices. Files stay on the transfer shelf.', { exact: true }).isVisible(), true);
    assert.equal(await dialog.getByText('Incoming items are saved to history even when automatic history is off. This preference also controls whether sync replaces what is currently copied.', { exact: true }).isVisible(), true);
    assert.equal(await dialog.getByText(/With Sync on, supported new copies can be sent to paired devices/).isVisible(), true);
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
    assert.equal(await dialog.getByRole('status', { name: /Pairing code/ }).count(), 0);
    assert.deepEqual(page.errors, [], 'Missing clipboardSync does not crash settings');

    await dialog.getByRole('switch', { name: 'Enable Clipboard tools', exact: true }).click();
    await page.waitForFunction(() => {
      const control = document.querySelector('[aria-label="Sync between devices"]');
      return control && control.disabled === false && control.getAttribute('aria-checked') === 'false';
    });
    assert.equal(await lockedNote.count(), 0);
    assert.equal(await allow.isDisabled(), true, 'Pairing is unavailable while sync is off');
    assert.equal(await codeInput.isDisabled(), true);
    assert.equal(await machine.isDisabled(), true);
    assert.equal(await direction.isDisabled(), true);
    assert.equal(await history.isEnabled(), true);
    assert.equal(await history.isChecked(), true);
    assert.equal(await pair.isDisabled(), true);

    await page.evaluate(() => {
      const publish = () => structuredClone(window.__state);
      const sync = () => {
        if (!window.__state.clipboardSync || typeof window.__state.clipboardSync !== 'object') window.__state.clipboardSync = { available: true, enabled: false, paused: false, receiveMode: 'history', peers: [] };
        if (!Array.isArray(window.__state.clipboardSync.peers)) window.__state.clipboardSync.peers = [];
        return window.__state.clipboardSync;
      };
      window.drift.updateClipboardSync = async (value) => { window.__calls.push({ method: 'updateClipboardSync', value }); Object.assign(sync(), value); return publish(); };
      window.drift.beginClipboardPairing = async () => { window.__calls.push({ method: 'beginClipboardPairing' }); sync().pairing = { code: 'ABCDEFGH', expiresAt: '2026-09-28T09:35:00.000Z' }; return publish(); };
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
    });

    await syncSwitch.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Sync between devices"]')?.getAttribute('aria-checked') === 'true');
    assert.equal(await allow.isEnabled(), true);
    assert.equal(await codeInput.isEnabled(), true);
    assert.equal(await machine.isEnabled(), true);
    assert.equal(await direction.isEnabled(), true);
    assert.equal(await pair.isDisabled(), true, 'Pairing still needs a machine and a valid code');
    assert.equal(await codeInput.getAttribute('maxLength'), '8');
    assert.equal(await codeInput.getAttribute('pattern'), '[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}');
    assert.equal(await dialog.getByText('Enter the 8-character code shown on the other computer. The code uses letters and numbers without I, O, 0, or 1.', { exact: true }).isVisible(), true);
    await machine.selectOption('host-0');
    await codeInput.fill('ABCDEFGI');
    assert.equal(await pair.isDisabled(), true, 'Ambiguous and invalid characters cannot be paired');
    assert.equal(await codeInput.getAttribute('aria-invalid'), 'true');
    await codeInput.fill('abcdefgh');
    assert.equal(await codeInput.inputValue(), 'ABCDEFGH', 'Typed codes are normalized to uppercase');
    assert.equal(await codeInput.getAttribute('aria-invalid'), 'false');
    assert.equal(await pair.isEnabled(), true);
    await syncSwitch.focus();
    assert.equal(await syncSwitch.evaluate((node) => node === document.activeElement), true);

    await page.evaluate(() => {
      window.__state.clipboardSync.available = false;
      window.__listeners.state(structuredClone(window.__state));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Pair this computer')?.disabled === true);
    assert.equal(await allow.isDisabled(), true, 'Pairing is blocked when secure storage is unavailable');
    assert.equal(await machine.isDisabled(), true);
    assert.equal(await codeInput.isDisabled(), true);
    assert.equal(await dialog.getByRole('status').filter({ hasText: 'A secure system store is unavailable.' }).isVisible(), true);
    await page.evaluate(() => {
      window.__state.clipboardSync.available = true;
      window.__listeners.state(structuredClone(window.__state));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Allow pairing')?.disabled === false);

    const globalPause = dialog.getByRole('button', { name: 'Pause clipboard sync', exact: true });
    await globalPause.click();
    await dialog.getByRole('button', { name: 'Resume clipboard sync', exact: true }).waitFor();
    assert.deepEqual((await calls(page, 'updateClipboardSync')).at(-1), { paused: true });
    assert.equal(await allow.isDisabled(), true, 'Pairing is blocked while sync is paused');
    assert.equal(await codeInput.isDisabled(), true);
    assert.equal(await machine.isDisabled(), true);
    assert.equal(await direction.isDisabled(), true);
    assert.equal(await pair.isDisabled(), true);
    await dialog.getByRole('button', { name: 'Resume clipboard sync', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Allow pairing')?.disabled === false);

    await page.evaluate(() => {
      window.__state.clipboardSync = { available: true, enabled: true, paused: false, receiveMode: 'history', error: 'Studio does not have a ready ShelfDock sync endpoint.', peers: [{ id: 'peer-studio', label: 'Studio', direction: 'both', paused: false, status: 'connected', hostId: 'host-0' }] };
      window.__clips.entries[0].sourceLabel = 'Studio';
      window.__listeners.state(structuredClone(window.__state));
    });

    await page.waitForFunction(() => document.querySelector('[aria-label="Sync between devices"]')?.getAttribute('aria-checked') === 'true');
    const revoke = dialog.getByRole('button', { name: 'Revoke', exact: true });
    await revoke.waitFor();
    assert.equal(await revoke.isEnabled(), true);
    assert.equal(await dialog.getByText('Connected', { exact: true }).isVisible(), true);
    assert.equal(await dialog.getByText('Revoke stops that computer immediately. Clipboard history on this device stays here.', { exact: true }).isVisible(), true);
    assert.match(await dialog.getByRole('alert').innerText(), /Studio does not have a ready ShelfDock sync endpoint/);

    await page.evaluate(() => {
      window.__state.clipboardSync.peers[0].status = 'offline';
      window.__listeners.state(structuredClone(window.__state));
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.clipboard-sync-peer-status')].some(node => node.textContent === 'Offline'));
    assert.equal(await dialog.getByText('Offline', { exact: true }).isVisible(), true);
    await page.evaluate(() => {
      window.__state.clipboardSync.peers[0].status = 'connected';
      window.__listeners.state(structuredClone(window.__state));
    });

    await dialog.getByRole('button', { name: 'Pause clipboard sync', exact: true }).click();
    await dialog.getByRole('button', { name: 'Resume clipboard sync', exact: true }).waitFor();
    assert.equal(await dialog.getByText('Paused on this computer', { exact: true }).isVisible(), true);
    assert.equal(await allow.isDisabled(), true);
    await dialog.getByRole('button', { name: 'Resume clipboard sync', exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Allow pairing')?.disabled === false);

    await dialog.getByRole('combobox', { name: 'Direction for Studio', exact: true }).selectOption('send');
    await dialog.getByRole('button', { name: 'Pause sync with Studio', exact: true }).click();
    assert.equal(await dialog.getByText('Paused here', { exact: true }).isVisible(), true, 'Peer pause state is shown with its source');
    await revoke.click();
    await page.waitForFunction(() => window.__calls.some((call) => call.method === 'revokeClipboardPeer'));
    assert.deepEqual(await page.evaluate(() => window.__calls.filter((call) => call.method === 'updateClipboardPeer').map((call) => call.value)), [
      { id: 'peer-studio', direction: 'send' },
      { id: 'peer-studio', paused: true },
    ]);
    assert.deepEqual(await page.evaluate(() => window.__calls.find((call) => call.method === 'revokeClipboardPeer').value), { id: 'peer-studio' });
    assert.equal(await dialog.getByRole('button', { name: 'Revoke', exact: true }).count(), 0);

    await allow.click();
    const pairingStatus = dialog.getByRole('status', { name: 'Pairing code ABCDEFGH', exact: true });
    await pairingStatus.waitFor();
    assert.equal((await pairingStatus.innerText()).trim(), 'ABCDEFGH');
    assert.equal(await dialog.locator('.clipboard-sync-expiry time').getAttribute('dateTime'), '2026-09-28T09:35:00.000Z');
    await machine.selectOption('host-0');
    await codeInput.fill('234567ab');
    await direction.selectOption('receive');
    await pair.click();
    await page.waitForFunction(() => window.__calls.some((call) => call.method === 'pairClipboardSync'));
    assert.deepEqual(await page.evaluate(() => window.__calls.find((call) => call.method === 'pairClipboardSync').value), { hostId: 'host-0', code: '234567AB', direction: 'receive' });

    await history.focus();
    await history.press('ArrowDown');
    await page.waitForFunction(() => window.__calls.some((call) => call.method === 'updateClipboardSync' && call.value && call.value.receiveMode === 'clipboard'));
    assert.equal(await systemClipboard.isChecked(), true);
    await syncSwitch.focus();
    await syncSwitch.press('Space');
    await page.waitForFunction(() => window.__calls.some((call) => call.method === 'updateClipboardSync' && call.value && call.value.enabled === false));
    assert.equal(await allow.isDisabled(), true, 'Pairing is blocked after sync is turned off');
    assert.equal(await machine.isDisabled(), true);
    assert.equal(await codeInput.isDisabled(), true);
    assert.equal(await pair.isDisabled(), true);
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
    console.log('Clipboard sync: pairing gates, code validation, receive preference, peer state, and accessible pairing code.');
    await page.close();
  } finally { await app.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
