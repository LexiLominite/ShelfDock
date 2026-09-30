'use strict';
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const harness = require('./harness.cjs');
const { RemoteDesktop } = require('../../desktop/remote-desktop.cjs');

(async () => {
  let pointers = 0;
  const sockets = new Set();
  const tcp = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let phase = 0, buffer = Buffer.alloc(0), painted = false;
    socket.write('RFB 003.008\n');
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      while (buffer.length) {
        if (phase === 0) { if (buffer.length < 12) return; buffer = buffer.subarray(12); socket.write(Buffer.from([1, 1])); phase++; }
        else if (phase === 1) { buffer = buffer.subarray(1); socket.write(Buffer.alloc(4)); phase++; }
        else if (phase === 2) {
          buffer = buffer.subarray(1); const name = Buffer.from('ShelfDock fixture desktop'); const init = Buffer.alloc(24 + name.length);
          init.writeUInt16BE(64, 0); init.writeUInt16BE(48, 2); init[4] = 32; init[5] = 24; init[7] = 1;
          init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12); init[14] = 16; init[15] = 8; init[16] = 0;
          init.writeUInt32BE(name.length, 20); name.copy(init, 24); socket.write(init); phase++;
        } else {
          const type = buffer[0]; let size = { 0: 20, 3: 10, 4: 8, 5: 6 }[type];
          if (type === 2) { if (buffer.length < 4) return; size = 4 + buffer.readUInt16BE(2) * 4; }
          if (type === 6) { if (buffer.length < 8) return; size = 8 + buffer.readUInt32BE(4); }
          if (!size) { socket.destroy(new Error('Unexpected RFB client message ' + type)); return; }
          if (buffer.length < size) return;
          if (type === 5) pointers++;
          if (type === 3 && !painted) { painted = true; const frame = Buffer.alloc(16 + 64 * 48 * 4); frame.writeUInt16BE(1, 2); frame.writeUInt16BE(64, 8); frame.writeUInt16BE(48, 10); for (let i = 16; i < frame.length; i += 4) { frame[i] = 160; frame[i + 1] = 90; frame[i + 2] = 30; } socket.write(frame); }
          buffer = buffer.subarray(size);
        }
      }
    });
  });
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
  const rd = new RemoteDesktop({ service: { getState: async () => ({ hosts: [{ id: 'host-0', name: 'Studio', user: 'fixture', os: 'posix' }] }) }, allowedOrigins: ['fixture'], connect: async () => { const socket = net.connect(tcp.address().port, '127.0.0.1'); await once(socket, 'connect'); return socket; } });
  const app = await harness();
  try {
    const page = await app.page('expanded');
    // The production bridge requires a known renderer origin. This fixture records its harness origin.
    rd.allowedOrigins = new Set([new URL(page.url()).origin]);
    await page.exposeFunction('__desktopStart', request => rd.start(request));
    await page.exposeFunction('__desktopStop', request => rd.stop(request));
    await page.evaluate(() => {
      const start = window.drift.startRemoteDesktop, stop = window.drift.stopRemoteDesktop;
      window.drift.startRemoteDesktop = async request => { await start(request); return window.__desktopStart(request); };
      window.drift.stopRemoteDesktop = async request => { await stop(request); return window.__desktopStop(request); };
    });
    const card = page.locator('[data-host-id="host-0"]'); await card.locator('.machine-main').focus(); await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: /Remote screen/ }).click();
    await page.getByText('Remote desktop is available.').waitFor(); await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('button', { name: 'View mode', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.vnc-mode-btn') && !document.querySelector('.vnc-mode-btn').disabled);
    const canvas = page.locator('.vnc-screen canvas'); await canvas.waitFor();
    await canvas.click({ position: { x: 30, y: 20 } }); await page.waitForTimeout(50); assert.equal(pointers, 0, 'View mode must suppress mouse messages');
    await page.getByRole('button', { name: 'View mode', exact: true }).click(); await canvas.click({ position: { x: 30, y: 20 } });
    await page.waitForTimeout(50); assert.ok(pointers > 0, 'Control mode must forward mouse messages through SSH bridge');
    assert.equal(rd.getState().session.status, 'connected');
    await page.getByRole('button', { name: 'Fit to window', exact: true }).click(); await page.getByRole('button', { name: 'Actual size', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await page.getByRole('button', { name: 'Connect', exact: true }).waitFor();
    assert.equal(rd.getState().session, null);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.vnc-mode-btn') && !document.querySelector('.vnc-mode-btn').disabled);
    await page.getByRole('button', { name: 'View mode', exact: true }).waitFor(); await page.getByRole('button', { name: 'Fit to window', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    assert.deepEqual(page.errors, []);
    const cancelPage = await app.page('expanded');
    await cancelPage.evaluate(() => { window.drift.inspectRemoteDesktop = () => new Promise(resolve => { window.__finishDesktopInspect = resolve; }); });
    await cancelPage.locator('[data-host-id="host-0"] .machine-main').focus(); await cancelPage.keyboard.press('Shift+F10');
    await cancelPage.getByRole('menuitem', { name: /Remote screen/ }).click(); await cancelPage.getByText('Checking desktop access…').waitFor();
    await cancelPage.getByRole('button', { name: 'Cancel', exact: true }).click(); await cancelPage.getByRole('dialog').waitFor({ state: 'hidden' });
    await cancelPage.evaluate(() => window.__finishDesktopInspect({ available: true, provider: 'linux-x11', port: 5900, reason: 'Late result' }));
    assert.deepEqual(cancelPage.errors, []);
    const setupPage = await app.page('expanded');
    await setupPage.evaluate(() => {
      window.__desktopReviews = 0; window.__desktopApplies = [];
      window.drift.previewRemoteDesktopSetup = async () => ({ available: true, id: 'review-' + (++window.__desktopReviews), changes: ['Temporary loopback server'] });
      window.drift.applyRemoteDesktopSetup = async request => { window.__desktopApplies.push(request.planId); if (request.planId === 'review-1') throw new Error('This setup review expired or was already used. Review a new plan.'); return { ownedServer: { hostId: 'host-0', port: 5900 } }; };
    });
    await setupPage.locator('[data-host-id="host-0"] .machine-main').focus(); await setupPage.keyboard.press('Shift+F10'); await setupPage.getByRole('menuitem', { name: /Remote screen/ }).click();
    await setupPage.getByRole('button', { name: 'Review temporary sharing setup', exact: true }).click();
    await setupPage.getByLabel('Temporary VNC password').fill('bad pw'); assert.equal(await setupPage.getByRole('button', { name: 'Set up desktop sharing', exact: true }).isDisabled(), true);
    await setupPage.getByLabel('Temporary VNC password').fill('secret'); await setupPage.getByRole('button', { name: 'Set up desktop sharing', exact: true }).click();
    await setupPage.getByRole('alert').filter({ hasText: 'expired' }).waitFor(); await setupPage.getByRole('button', { name: 'Review temporary sharing setup', exact: true }).click();
    await setupPage.getByLabel('Temporary VNC password').fill('secret'); await setupPage.getByRole('button', { name: 'Set up desktop sharing', exact: true }).click();
    await setupPage.getByRole('button', { name: 'Connect', exact: true }).waitFor(); assert.deepEqual(await setupPage.evaluate(() => window.__desktopApplies), ['review-1', 'review-2']);
    assert.deepEqual(setupPage.errors, []); console.log('Remote desktop real RFB viewer/bridge, cancellation and setup retry UI passed.');
  } finally { await app.close(); await rd.shutdown(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => tcp.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
