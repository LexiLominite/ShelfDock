'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createConfig, validateConfig, importConfiguration, MAX_BYTES } = require('../desktop/config.cjs');
const { DriftService } = require('../desktop/service.cjs');

const machine = (extra = {}) => ({ name: 'Example workstation', address: '192.168.1.20', user: 'example', port: 22, destination: '~/Desktop', route: 'lan', os: 'posix', ...extra });
const document = (hosts = [machine()], settings = {}) => ({ schema: 'lex-drift-config', version: 1, hosts, settings });
function stub(hosts = []) {
  return {
    initialized: Promise.resolve(), manualHosts: hosts.filter(host => host.source === 'Manual'), overrides: {}, hiddenHosts: [], transferring: false,
    state: { hosts, settings: { shakeEnabled: true, sensitivity: 'normal', viewMode: 'expanded', sendImmediately: false }, items: [{ id: 'private-note', path: '/private/local/note', preview: 'secret note' }], history: [{ destination: '/private/receipt' }] },
    commits: [], emissions: 0,
    async persist() { this.commits.push(JSON.parse(JSON.stringify({ hosts: this.state.hosts, settings: this.state.settings }))); },
    emit() { this.emissions++; },
    async getState() { return JSON.parse(JSON.stringify(this.state)); }
  };
}

test('portable export includes configured endpoints and view preferences without local auth, clipboard, shelf, or receipts', () => {
  const config = createConfig({
    hosts: [machine({ id: 'local-id', identityFile: '/private/key', sshAlias: 'LocalAlias', password: 'private-password', source: 'SSH', status: 'ready' }), machine({ address: '100.64.0.50', user: '', name: 'Unconfigured peer' })],
    settings: { shakeEnabled: false, sensitivity: 'strong', viewMode: 'large', clipboardWatch: true, sendImmediately: true },
    items: [{ path: '/private/note', preview: 'private text' }], history: [{ destination: '/private/receipt' }], clipboard: 'clipboard secret'
  });
  assert.deepEqual(config.hosts, [machine()]);
  assert.deepEqual(config.settings, { shakeEnabled: false, sensitivity: 'strong', viewMode: 'large' });
  const serialized = JSON.stringify(config);
  for (const sensitive of ['private', 'identityFile', 'sshAlias', 'password', 'clipboard', 'sendImmediately', 'status', 'history']) assert.equal(serialized.includes(sensitive), false);
  assert.deepEqual(validateConfig(serialized), config);
});

test('configuration defaults and Windows destinations round trip across devices', () => {
  const config = validateConfig(document([machine({ address: '[2001:db8::1]', os: 'windows', destination: 'C:/Users/example/OneDrive/Desktop', route: 'ssh' })]));
  assert.equal(config.hosts[0].address, '2001:db8::1');
  assert.deepEqual(config.settings, {});
  assert.deepEqual(validateConfig(JSON.stringify(config)), config);
});

test('configuration rejects unknown authentication, command, and prototype fields everywhere', () => {
  for (const key of ['identityFile', 'sshAlias', 'password', 'ProxyCommand', 'executable', 'privateKey', 'status', 'id']) assert.throws(() => validateConfig(document([machine({ [key]: 'anything' })])), /unsupported field/);
  assert.throws(() => validateConfig({ ...document(), clipboard: 'secret' }), /unsupported field/);
  assert.throws(() => validateConfig(document([], { clipboardWatch: true })), /unsupported field/);
  assert.throws(() => validateConfig('{"schema":"lex-drift-config","version":1,"hosts":[],"__proto__":{"polluted":true}}'), /unsupported field/);
  assert.equal({}.polluted, undefined);
});

test('configuration validates bounds, endpoint types, duplicates, and settings before an import', () => {
  for (const input of [null, '', '{', '{}', { ...document(), version: 2 }, { ...document(), schema: 'other' }]) assert.throws(() => validateConfig(input));
  assert.throws(() => validateConfig(' '.repeat(MAX_BYTES + 1)), /no larger than 1 MB/);
  assert.throws(() => validateConfig(document(Array.from({ length: 501 }, (_, index) => machine({ address: `host-${index}` })))), /at most 500/);
  assert.throws(() => validateConfig(document([machine(), machine({ address: '192.168.1.20', name: 'Same endpoint' })])), /repeats/);
  for (const extra of [{ user: '' }, { address: '-oProxyCommand=oops' }, { address: 'https://example.com' }, { address: 'bad..name' }, { port: '22' }, { port: 65536 }, { name: 'line\nbreak' }, { destination: './relative' }, { destination: '/path\0bad' }, { os: 'linux' }, { route: 'wifi' }]) assert.throws(() => validateConfig(document([machine(extra)])));
  for (const settings of [{ shakeEnabled: 'true' }, { sensitivity: 'extreme' }, { viewMode: 'giant' }]) assert.throws(() => validateConfig(document([], settings)));
});

test('one invalid later host prevents every host/settings mutation and every disk write', async () => {
  const service = stub(); const before = JSON.stringify(service.state);
  await assert.rejects(importConfiguration(service, document([machine(), machine({ user: '', address: '192.168.1.21' })], { viewMode: 'large' })), /username/);
  assert.equal(JSON.stringify(service.state), before);
  assert.equal(service.commits.length, 0);
  assert.equal(service.emissions, 0);
  assert.equal(service.configurationImport, undefined);
});

test('import merges exact endpoints, preserves their local auth, leaves other hosts, and commits once', async () => {
  const local = machine({ id: 'wave-id', source: 'Wave', identityFile: '~/.ssh/local-key', sshAlias: 'LocalWaveAlias', status: 'ready', error: 'old error' });
  const other = machine({ address: '192.168.1.21', id: 'other-id', source: 'Manual', identityFile: '/local/other-key', sshAlias: '', status: 'ready' });
  const service = stub([local, other]);
  service.hiddenHosts.push(local.id);
  const result = await importConfiguration(service, document([machine({ name: 'Renamed workstation', destination: '~/Desktop/Incoming' }), machine({ user: 'another-login', name: 'New login' })], { viewMode: 'compact' }));
  assert.deepEqual(result.configurationImportSummary, { added: 1, updated: 1 });
  assert.equal(result.hosts.length, 3);
  const merged = result.hosts.find(host => host.id === local.id);
  assert.equal(merged.name, 'Renamed workstation');
  assert.equal(merged.identityFile, '~/.ssh/local-key');
  assert.equal(merged.sshAlias, 'LocalWaveAlias');
  assert.equal(merged.status, 'unknown');
  assert.equal(merged.error, undefined);
  assert.equal(service.overrides[local.id].destination, '~/Desktop/Incoming');
  assert.equal(service.hiddenHosts.includes(local.id), false);
  const added = result.hosts.find(host => host.user === 'another-login');
  assert.equal(added.source, 'Manual');
  assert.equal(added.identityFile, '');
  assert.equal(added.sshAlias, '');
  assert.equal(service.manualHosts.filter(host => host.id === added.id).length, 1);
  assert.deepEqual(result.items, service.state.items);
  assert.equal(result.settings.viewMode, 'compact');
  assert.equal(result.settings.sendImmediately, false);
  assert.equal(service.commits.length, 1);
  assert.equal(service.emissions, 1);
  assert.equal(service.configurationImport, false);
});

test('failed persistence restores all configuration fields and republishes the restored state', async () => {
  const local = machine({ id: 'saved-id', source: 'Manual', identityFile: '/local/key', sshAlias: '', status: 'ready' });
  const service = stub([local]); const before = JSON.stringify({ manualHosts: service.manualHosts, overrides: service.overrides, hiddenHosts: service.hiddenHosts, state: service.state });
  service.persist = async () => { throw new Error('Disk full'); };
  await assert.rejects(importConfiguration(service, document([machine({ name: 'Should not remain' })], { viewMode: 'large' })), /Disk full/);
  assert.equal(JSON.stringify({ manualHosts: service.manualHosts, overrides: service.overrides, hiddenHosts: service.hiddenHosts, state: service.state }), before);
  assert.equal(service.emissions, 1);
  assert.equal(service.configurationImport, false);
});

test('import refuses active transfers and waits for an existing scan while exposing its mutation guard', async () => {
  const service = stub(); service.transferring = true;
  await assert.rejects(importConfiguration(service, document()), /transfer to finish/);
  service.transferring = false;
  let release;
  service.scanPromise = new Promise(resolve => { release = resolve; });
  const pending = importConfiguration(service, document());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.configurationImport, true);
  assert.equal(service.commits.length, 0);
  await assert.rejects(importConfiguration(service, document()), /current configuration import/);
  release(); await pending;
  assert.equal(service.configurationImport, false);
  assert.equal(service.commits.length, 1);
});

test('imported manual routes persist and reload with the actual service', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-drift-config-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const service = new DriftService({ dataDir });
  const input = document([machine(), machine({ address: '100.64.0.20', route: 'tailscale', name: 'Example Tailscale route' })], { viewMode: 'large', shakeEnabled: false });
  await importConfiguration(service, input);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.manualHosts.length, 2);
  assert.equal(saved.settings.viewMode, 'large');
  const reopened = new DriftService({ dataDir });
  const state = await reopened.getState();
  assert.equal(state.hosts.length, 2);
  assert.equal(state.hosts[0].user, 'example');
  assert.equal(state.settings.shakeEnabled, false);
  assert.equal(state.settings.viewMode, 'large');
  // Host export remains portable even though the application's own state has IDs.
  assert.deepEqual(createConfig(state).hosts.sort((a, b) => a.address.localeCompare(b.address)), validateConfig(input).hosts.sort((a, b) => a.address.localeCompare(b.address)));
});

test('partial imported preferences preserve unrelated settings and public 100 addresses are not inferred as Tailscale', async () => {
  const service = stub();
  service.state.settings.sensitivity = 'strong';
  service.state.settings.viewMode = 'large';
  await importConfiguration(service, document([machine({ address: '100.10.1.20', route: undefined })], { shakeEnabled: false }));
  assert.equal(service.state.settings.sensitivity, 'strong');
  assert.equal(service.state.settings.viewMode, 'large');
  assert.equal(service.state.settings.shakeEnabled, false);
  assert.equal(service.state.hosts[0].route, 'ssh');
});
