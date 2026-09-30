'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const preloadPath = path.join(__dirname, '..', 'desktop', 'preload.cjs');
const preloadSource = fs.readFileSync(preloadPath, 'utf8');

function loadPreload() {
  const calls = [];
  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api }; } },
    ipcRenderer: {
      invoke: (channel, ...args) => { calls.push({ channel, args }); return Promise.resolve(); },
      on() {},
      removeListener() {},
    },
    webUtils: { getPathForFile: () => '' },
  };
  vm.runInNewContext(preloadSource, {
    require: name => {
      if (name !== 'electron') throw new Error(`Unexpected preload dependency: ${name}`);
      return electron;
    },
    process: { argv: [] },
  }, { filename: preloadPath });
  assert.equal(exposed.name, 'drift');
  return { api: exposed.api, calls };
}

test('preload forwards a targeted host probe and leaves no-argument probes global', async () => {
  const { api, calls } = loadPreload();

  await api.probeHosts({ hostId: 'machine-b' });
  assert.equal(calls[0].channel, 'drift:probeHosts');
  assert.equal(calls[0].args.length, 1);
  assert.equal(calls[0].args[0].hostId, 'machine-b');

  await api.probeHosts();
  assert.equal(calls[1].channel, 'drift:probeHosts');
  assert.ok(calls[1].args.every(argument => argument === undefined), 'a global probe receives no host selection');
});


test('preload exposes reviewed remote operations through fixed IPC channels', async () => {
  const { api, calls } = loadPreload();
  for (const method of ['getRemoteDesktopState', 'inspectRemoteDesktop', 'previewRemoteDesktopSetup', 'applyRemoteDesktopSetup', 'startRemoteDesktop', 'stopRemoteDesktop', 'getRemoteInstallState', 'previewRemoteInstall', 'installRemotely', 'cancelRemoteInstall', 'confirmRendererReady']) {
    await api[method]({ hostId: 'saved-device', planId: 'single-use-plan' });
    assert.equal(calls.at(-1).channel, 'drift:' + method);
  }
});
