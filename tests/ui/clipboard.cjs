'use strict';
const assert = require('node:assert/strict');
const harness = require('./harness.cjs');

const modes = { compact: 'compact', expanded: 'balanced', large: 'expanded' };
const expectFocus = async locator => { await locator.evaluate(node => new Promise((resolve, reject) => { const until = performance.now() + 1000; function check() { if (node === document.activeElement) resolve(); else if (performance.now() > until) reject(new Error('Expected focus on ' + node.outerHTML)); else requestAnimationFrame(check); } check(); })); };
const countCalls = (page, method) => page.evaluate(method => window.__calls.filter(call => call.method === method).length, method);
const openClipboard = async page => {
  await page.getByRole('button', { name: 'Clipboard', exact: true }).click();
  await page.locator('.clipboard-list [role="option"]').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.clipboard-list')?.getAttribute('aria-busy') === 'false');
  return page.getByRole('region', { name: 'Clipboard workspace' });
};
const fresh = async (app, mode, run) => {
  const page = await app.page(mode, { entries: 35, hosts: 12 });
  try { await run(page); assert.deepEqual(page.errors, [], `No browser exceptions in ${mode}`); }
  finally { await page.close(); }
};

(async () => {
  const app = await harness();
  try {
    for (const [mode, density] of Object.entries(modes)) {
      await fresh(app, mode, async page => {
        await openClipboard(page);
        assert.equal(await page.locator(`.clipboard-mode-${density}`).count(), 1);
        const geometry = await page.locator('.clipboard-pane').evaluate(pane => {
          const list = pane.querySelector('.clipboard-list');
          const content = pane.querySelector('.clipboard-content');
          const bounds = pane.getBoundingClientRect();
          const listBounds = list.getBoundingClientRect();
          return { overflow: getComputedStyle(pane).overflowY, listOverflow: getComputedStyle(list).overflowY, paneHeight: pane.clientHeight, paneScroll: pane.scrollHeight, listHeight: list.clientHeight, listScroll: list.scrollHeight, contentOverflow: getComputedStyle(content).overflowY, width: pane.clientWidth, scrollWidth: pane.scrollWidth, listInside: listBounds.top >= bounds.top && listBounds.bottom <= bounds.bottom + 1 };
        });
        assert.equal(geometry.overflow, 'hidden', `${mode}: pane is not an extra scroller`);
        assert.equal(geometry.listOverflow, 'auto');
        assert.equal(geometry.contentOverflow, 'hidden');
        assert.ok(geometry.listHeight >= 70, `${mode}: useful history height ${JSON.stringify(geometry)}`);
        assert.ok(geometry.listScroll > geometry.listHeight, `${mode}: long fixture scrolls in history`);
        assert.ok(geometry.listInside, `${mode}: history remains within workspace`);
        assert.ok(geometry.scrollWidth <= geometry.width + 1, `${mode}: no horizontal clipping`);
        assert.ok(geometry.paneScroll <= geometry.paneHeight + 2, `${mode}: footer/actions fit ${JSON.stringify(geometry)}`);
        assert.equal(await page.locator('.clipboard-list button').count(), 0, 'Rows do not create extra action tab stops');
        assert.equal(await page.locator('.clipboard-list [role="option"]').count(), 35);
        assert.ok(await countCalls(page, 'getClipboardEntry') < 4, 'Only selected bodies are fetched');
        if (mode === 'compact') {
          assert.equal(await page.getByRole('region', { name: 'Clipboard item preview' }).count(), 0);
          await page.getByRole('button', { name: 'Preview', exact: true }).click();
          await page.getByRole('region', { name: 'Clipboard item preview' }).waitFor();
          await page.getByRole('button', { name: 'Close clipboard preview' }).click();
          await expectFocus(page.getByRole('button', { name: 'Preview', exact: true }));
        }
        if (mode === 'expanded') {
          assert.ok(geometry.listHeight >= 240, 'Balanced narrow pane leaves room for several history items');
          const preview = page.getByRole('region', { name: 'Clipboard item preview' });
          assert.equal(await preview.isVisible(), false, 'Balanced narrow pane defaults to history space');
          await page.getByRole('button', { name: 'Preview', exact: true }).click();
          await preview.waitFor({ state: 'visible' });
          await page.getByRole('button', { name: 'Close clipboard preview' }).click();
          assert.equal(await preview.isVisible(), false);
          await expectFocus(page.getByRole('button', { name: 'Preview', exact: true }));
        }
        console.log(`PASS Clipboard ${density}: real density, scrolling, lazy detail, bounded layout`);
      });
    }

    await fresh(app, 'expanded', async page => {
      await openClipboard(page);
      const search = page.getByRole('textbox', { name: 'Search clipboard history' });
      await search.fill('Project');
      await page.waitForFunction(() => document.querySelector('.clipboard-list')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.clipboard-entry').length === 6);
      const list = page.getByRole('listbox', { name: 'Clipboard history' });
      await list.focus();
      await list.press('End');
      const selected = await list.getAttribute('aria-activedescendant');
      await page.waitForFunction(() => document.querySelector('.clipboard-list').scrollTop > 0);
      const savedScroll = await list.evaluate(node => node.scrollTop);
      await page.getByRole('button', { name: /^Transfers/ }).click();
      await page.getByRole('button', { name: 'Clipboard', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.clipboard-list')?.getAttribute('aria-busy') === 'false');
      assert.equal(await search.inputValue(), 'Project');
      const restored = await list.getAttribute('aria-activedescendant');
      assert.equal(restored?.split('-clipboard-')[1], selected?.split('-clipboard-')[1], 'Selected entry survives remount');
      await page.waitForFunction(expected => Math.abs(document.querySelector('.clipboard-list').scrollTop - expected) <= 2, savedScroll);
      await page.getByRole('button', { name: 'Pinned', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.clipboard-list')?.getAttribute('aria-busy') === 'false');
      await page.getByRole('button', { name: /^Transfers/ }).click();
      await page.getByRole('button', { name: 'Clipboard', exact: true }).click();
      await page.getByRole('button', { name: 'Pinned', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Pinned', exact: true }).getAttribute('aria-pressed'), 'true');
      console.log('PASS Clipboard search/filter/selection/scroll persist across workspace switches');
    });

    await fresh(app, 'compact', async page => {
      await openClipboard(page);
      const list = page.getByRole('listbox', { name: 'Clipboard history' });
      await list.focus();
      await list.press('ArrowDown');
      await page.waitForFunction(() => !document.querySelector('.clipboard-action-primary button').disabled);
      const active = await list.getAttribute('aria-activedescendant');
      assert.ok(active.endsWith('clip-1'));
      const pinCount = await countCalls(page, 'setClipboardPinned');
      await list.press('Enter');
      await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
      assert.equal(await countCalls(page, 'copyClipboardEntry'), 1);
      assert.equal(await countCalls(page, 'setClipboardPinned'), pinCount, 'Enter copies without pinning');
      assert.deepEqual(await page.evaluate(() => window.__calls.find(call => call.method === 'copyClipboardEntry').value), { id: 'clip-1', plainText: false });
      await page.getByRole('button', { name: 'Pin', exact: true }).click();
      await page.getByRole('button', { name: 'Unpin', exact: true }).waitFor();
      assert.equal(await countCalls(page, 'setClipboardPinned'), pinCount + 1);
      await page.getByRole('button', { name: 'Clipboard preferences' }).click();
      await page.getByRole('dialog', { name: 'Clipboard history preferences' }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog').count(), 0);
      await expectFocus(page.getByRole('button', { name: 'Clipboard preferences' }));
      assert.equal(await countCalls(page, 'hideWindow'), 0, 'Local Escape does not hide app');
      await page.getByRole('button', { name: 'New snippet', exact: true }).click();
      await page.getByRole('dialog', { name: 'New text snippet' }).waitFor();
      await page.keyboard.press('Escape');
      await expectFocus(page.getByRole('button', { name: 'New snippet', exact: true }));
      console.log('PASS Clipboard keyboard copy/pin isolation, inline feedback, local Escape and focus restoration');
    });

    await fresh(app, 'expanded', async page => {
      await openClipboard(page);
      await page.getByRole('textbox', { name: 'Search clipboard history' }).fill('Meeting');
      await page.waitForFunction(() => document.querySelector('.clipboard-list')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.clipboard-entry').length === 6);
      const pinsBefore = await page.evaluate(() => window.__clips.entries.filter(entry => entry.pinned).length);
      await page.getByRole('button', { name: 'Clear unpinned…', exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Clear all unpinned clipboard history' });
      await confirm.waitFor();
      assert.match(await confirm.innerText(), /outside the current search and filter/);
      assert.match(await confirm.innerText(), /no Undo/);
      await page.waitForFunction(() => document.activeElement?.textContent === 'Cancel');
      await page.keyboard.press('Escape');
      assert.equal(await countCalls(page, 'clearClipboardHistory'), 0);
      assert.equal(await countCalls(page, 'hideWindow'), 0);
      await page.getByRole('button', { name: 'Clear unpinned…', exact: true }).click();
      await page.getByRole('button', { name: 'Clear all unpinned history', exact: true }).click();
      await page.waitForFunction(() => window.__calls.some(call => call.method === 'clearClipboardHistory'));
      assert.equal(await page.evaluate(() => window.__clips.entries.length), pinsBefore, 'Clear affects all unpinned items, not only visible matches');
      assert.equal(await countCalls(page, 'clearItems'), 0, 'Clipboard clear never clears shelf');
      console.log('PASS Clipboard destructive scope explicit and independent of shelf Undo');
    });

    await fresh(app, 'large', async page => {
      await page.evaluate(() => {
        window.__pendingDetails = {};
        window.drift.getClipboardEntry = id => {
          window.__calls.push({ method: 'getClipboardEntry', value: id });
          return new Promise(resolve => { window.__pendingDetails[id] = text => resolve({ id, kind: 'text', text }); });
        };
      });
      await openClipboard(page);
      await page.waitForFunction(() => Boolean(window.__pendingDetails['clip-0']));
      const list = page.getByRole('listbox', { name: 'Clipboard history' });
      await list.focus(); await list.press('ArrowDown');
      await page.waitForFunction(() => Boolean(window.__pendingDetails['clip-1']));
      await page.evaluate(() => window.__pendingDetails['clip-0']('STALE DETAIL MUST NOT DISPLAY'));
      assert.equal(await page.getByText('STALE DETAIL MUST NOT DISPLAY', { exact: true }).count(), 0);
      await list.press('Enter');
      assert.equal(await countCalls(page, 'copyClipboardEntry'), 0, 'Unresolved selection cannot copy a previous body');
      await page.evaluate(() => window.__pendingDetails['clip-1']('Selected detail is correct.'));
      await page.getByText('Selected detail is correct.', { exact: true }).waitFor();
      await list.press('Enter');
      await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.__calls.find(call => call.method === 'copyClipboardEntry').value), { id: 'clip-1', plainText: false });
      console.log('PASS Clipboard stale detail isolation and loading/copy race guard');
    });

    await fresh(app, 'large', async page => {
      await page.evaluate(() => { window.__clips.settings.enabled = false; });
      await openClipboard(page);
      assert.equal(await countCalls(page, 'captureClipboardHistory'), 0);
      assert.equal(await countCalls(page, 'copyClipboardEntry'), 0);
      assert.equal(await countCalls(page, 'updateClipboardPreferences'), 0);
      await page.getByText('History off', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Enable history…', exact: true }).click();
      assert.equal(await countCalls(page, 'updateClipboardPreferences'), 0, 'Opening explanation does not enable capture');
      await page.getByRole('button', { name: 'Turn on clipboard history', exact: true }).click();
      await page.getByText('Paused while editing', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByText('Recording locally', { exact: true }).waitFor();
      const search = page.getByRole('textbox', { name: 'Search clipboard history' });
      await search.focus();
      await page.getByText('Paused while editing', { exact: true }).waitFor();
      await page.getByRole('listbox', { name: 'Clipboard history' }).focus();
      await page.getByText('Recording locally', { exact: true }).waitFor();
      assert.equal(await countCalls(page, 'captureClipboardHistory'), 0, 'No automatic native reads in UI fixture');
      assert.equal(await countCalls(page, 'captureClipboard'), 0);
      console.log('PASS Clipboard opt-in boundary and truthful editing pause labels');
    });
    for (const mode of ['compact', 'expanded', 'large']) {
      const page = await app.page(mode, { clipboardToolsEnabled: false, entries: 5 });
      try {
        assert.equal(await page.getByRole('button', { name: 'Clipboard', exact: true }).count(), 0);
        assert.equal(await countCalls(page, 'getClipboardHistory'), 0, 'Disabled workspace never requests saved history');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const enable = page.getByRole('switch', { name: 'Enable Clipboard tools', exact: true });
        const show = page.getByRole('switch', { name: 'Show Clipboard tab', exact: true });
        assert.equal(await enable.getAttribute('aria-checked'), 'false');
        assert.equal(await show.isDisabled(), true);
        await enable.click(); await page.getByRole('button', { name: 'Clipboard', exact: true }).waitFor();
        assert.equal(await countCalls(page, 'updateClipboardPreferences'), 0, 'Enabling tools does not enable recording');
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await openClipboard(page); await page.getByText('History off', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Enable history…', exact: true }).click();
        await page.getByRole('button', { name: 'Turn on clipboard history', exact: true }).click();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await show.click();
        assert.equal(await page.getByRole('button', { name: 'Clipboard', exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.__clips.settings.enabled), true, 'Hiding keeps explicitly enabled history');
        await page.getByText(/Hiding does not pause history that you have enabled/).waitFor();
        await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await page.getByRole('region', { name: 'File and text shelf' }).waitFor();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await show.click(); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await openClipboard(page);
        await page.getByRole('button', { name: 'Settings', exact: true }).click(); await enable.click();
        assert.equal(await page.getByRole('button', { name: 'Clipboard', exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.__clips.settings.enabled), false);
        assert.equal(await page.evaluate(() => window.__clips.entries.length), 5, 'Disabling keeps saved entries');
        await enable.click(); await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await openClipboard(page); await page.getByText('History off', { exact: true }).waitFor();
        assert.equal(await countCalls(page, 'updateClipboardPreferences'), 1, 'Re-enabling tools does not restore prior recording consent');
        assert.equal(await countCalls(page, 'captureClipboardHistory'), 0);
        assert.deepEqual(page.errors, []);
        console.log(`PASS Clipboard optional tools, independent hide and explicit recording consent in ${mode}`);
      } finally { await page.close(); }
    }
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
