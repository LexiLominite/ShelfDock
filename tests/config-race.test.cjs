'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DriftService } = require('../desktop/service.cjs');
const { importConfiguration } = require('../desktop/config.cjs');

const importedConfig = { schema: 'lex-drift-config', version: 1, hosts: [{ name: 'Imported', address: '192.168.1.2', user: 'u', port: 22, route: 'lan', os: 'posix', destination: '~/Desktop' }], settings: { viewMode: 'compact' } };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-drift-config-race-test-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const emissions = []; const calls = [];
  const service = new DriftService({ dataDir, onChange: state => emissions.push(state), execFile: async (...args) => { calls.push(args); return { stdout: 'DRIFT_READY\n', stderr: '' }; } });
  await service.getState();
  const original = { id: 'original', name: 'Original', address: '192.168.1.2', user: 'u', port: 22, route: 'lan', os: 'posix', source: 'Manual', identityFile: '', sshAlias: '', status: 'ready', destination: '~/Desktop' };
  service.state.hosts = [original]; service.manualHosts = [original]; service.state.environment.sshAvailable = true;
  return { service, emissions, calls };
}

test('queued refresh continuation cannot probe or publish an uncommitted import and rollback restores visible state', async t => {
  const { service, emissions, calls } = await fixture(t);
  let release; service.scanPromise = new Promise(resolve => { release = resolve; });
  // Model a refresh callback already queued before import acquires its guard.
  const background = service.scanPromise.then(() => service.probeHosts()).catch(error => error.message);
  service.persist = async () => { await tick(); throw new Error('Disk full'); };
  const importing = importConfiguration(service, importedConfig);
  const failure = assert.rejects(importing, /Disk full/);
  await tick(); assert.equal(service.configurationImport, true); release();
  const backgroundResult = await background; await failure;
  assert.match(backgroundResult, /configuration import to finish/);
  assert.deepEqual(calls, [], 'no SSH command starts against an uncommitted configuration');
  assert.equal(service.state.hosts[0].name, 'Original'); assert.equal(service.state.hosts[0].status, 'ready');
  assert.ok(emissions.length >= 1, 'rollback emits the restored state');
  assert.ok(emissions.every(state => state.hosts[0].name === 'Original'), 'imported names never reach the UI before commit');
  assert.equal(emissions.at(-1).settings.viewMode, 'expanded'); assert.equal(service.configurationImport, false);
});

test('a probe waiting on an active scan rechecks the import guard after that scan completes', async t => {
  const { service, emissions, calls } = await fixture(t);
  let finishScan; service.scanPromise = new Promise(resolve => { finishScan = resolve; });
  const probe = service.probeHosts(); const rejection = assert.rejects(probe, /configuration import to finish/);
  await tick(); service.configurationImport = true; finishScan(); await rejection;
  assert.deepEqual(calls, []); assert.deepEqual(emissions, []);
});

test('a refresh waiting on an active probe rechecks the import guard before starting discovery', async t => {
  const { service, emissions, calls } = await fixture(t);
  let finishProbe; service.probePromise = new Promise(resolve => { finishProbe = resolve; });
  const refresh = service.refreshHosts(); const rejection = assert.rejects(refresh, /configuration import to finish/);
  await tick(); service.configurationImport = true; finishProbe(); await rejection;
  assert.deepEqual(calls, []); assert.deepEqual(emissions, []);
});

test('configuration import does not change endpoints during password or key setup', async t => {
  const { service, calls } = await fixture(t);
  const before = await service.getState();
  service.authenticationSetup = true;
  await assert.rejects(importConfiguration(service, importedConfig), /connection setup to finish/);
  assert.deepEqual(await service.getState(), before);
  assert.deepEqual(calls, []);
  assert.equal(service.configurationImport, undefined);
});
