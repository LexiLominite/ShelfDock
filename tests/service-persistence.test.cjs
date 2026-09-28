'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DriftService } = require('../desktop/service.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const configuration = service => clone({ manualHosts: service.manualHosts, overrides: service.overrides, hiddenHosts: service.hiddenHosts, settings: service.state.settings });
async function fixture(t, discovered = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-service-persistence-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'data'), events = [], forgotten = [];
  const auth = { initialized: Promise.resolve(), storageAvailable: () => false, metadata: () => ({}), forget: async host => forgotten.push({ host: clone(host), saved: JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8')) }) };
  const options = { dataDir, homeDir: directory, platform: 'linux', passwordAuth: auth, execFile: async () => { throw new Error('This fixture must not connect to a machine.'); } };
  const service = new DriftService({ ...options, onChange: state => events.push(state) }); await service.initialized;
  await service.saveHost({ name: 'Original', address: 'original.invalid', user: 'fixture', identityFile: '~/.ssh/original' });
  const id = service.state.hosts[0].id;
  if (discovered) { service.manualHosts = []; service.state.hosts[0].source = 'SSH'; service.overrides = { [id]: { name: 'Original override', identityFile: '~/.ssh/original' } }; }
  service.hiddenHosts = ['already-hidden']; await service.persist(); events.length = 0;
  return { service, options, id, events, forgotten, file: path.join(dataDir, 'state.json') };
}

const cases = [
  { name: 'adding a manual host', run: service => service.saveHost({ name: 'New machine', address: 'new.invalid', user: 'fixture' }) },
  ...[false, true].flatMap(discovered => [
    { name: `editing a ${discovered ? 'discovered' : 'manual'} host`, discovered, forgets: true, run: (service, id) => service.saveHost({ id, address: 'changed.invalid', name: 'Changed' }) },
    { name: `removing a ${discovered ? 'discovered' : 'manual'} host`, discovered, forgets: true, removes: true, run: (service, id) => service.removeHost(id) }
  ]),
  { name: 'updating settings', run: service => service.updateSettings({ deviceName: 'Changed device', viewMode: 'compact', shakeEnabled: false }) }
];
for (const scenario of cases) test(`failed persistence while ${scenario.name} preserves live, saved and restarted configuration`, async t => {
  const { service, options, id, events, forgotten, file } = await fixture(t, scenario.discovered);
  const before = configuration(service), state = await service.getState(), stored = await fs.readFile(file, 'utf8'), persist = service.persist.bind(service);
  let began, release; const started = new Promise(resolve => { began = resolve; }), pending = new Promise(resolve => { release = resolve; });
  service.persist = async () => { began(); await pending; throw new Error('Simulated disk failure'); };
  const operation = scenario.run(service, id), rejection = assert.rejects(operation, /Simulated disk failure/); await started;
  assert.deepEqual(configuration(service), before, 'uncommitted configuration is not exposed while the write is pending');
  assert.deepEqual(await service.getState(), state); assert.deepEqual(events, []); assert.deepEqual(forgotten, []);
  release(); await rejection;
  assert.deepEqual(configuration(service), before); assert.deepEqual(await service.getState(), state); assert.equal(await fs.readFile(file, 'utf8'), stored); assert.deepEqual(forgotten, []); assert.equal(service.configurationSaving, false);
  service.persist = persist; await service.persist(); assert.equal(await fs.readFile(file, 'utf8'), stored, 'a later save cannot resurrect the failed change');
  const restarted = new DriftService(options); await restarted.initialized; assert.deepEqual(configuration(restarted), before);
  if (!scenario.discovered) assert.deepEqual((await restarted.getState()).hosts, state.hosts);
  await scenario.run(service, id); assert.notDeepEqual(configuration(service), before, 'the mutation queue remains retryable');
  if (scenario.forgets) {
    assert.equal(forgotten.length, 1); const saved = forgotten[0].saved;
    if (scenario.removes) {
      assert.ok(!saved.manualHosts.some(host => host.id === id)); assert.ok(!Object.hasOwn(saved.overrides, id));
      if (scenario.discovered) assert.ok(saved.hiddenHosts.includes(id));
    } else assert.equal(scenario.discovered ? saved.overrides[id].address : saved.manualHosts.find(host => host.id === id).address, 'changed.invalid');
  } else assert.deepEqual(forgotten, []);
});

test('a failed host save cannot contaminate a concurrent disk write or a queued successful setting change', async t => {
  const { service, id, file } = await fixture(t), before = configuration(service), persist = service.persist.bind(service);
  let began, release, first = true; const started = new Promise(resolve => { began = resolve; }), pending = new Promise(resolve => { release = resolve; });
  service.persist = async (...args) => { if (first) { first = false; began(); await pending; throw new Error('Disk full'); } return persist(...args); };
  const edit = service.saveHost({ id, address: 'must-not-stick.invalid' }), failure = assert.rejects(edit, /Disk full/); await started;
  const settings = service.updateSettings({ deviceName: 'Successful change' }); await persist();
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).manualHosts, before.manualHosts);
  release(); await failure; await settings;
  const saved = JSON.parse(await fs.readFile(file, 'utf8')); assert.deepEqual(saved.manualHosts, before.manualHosts); assert.equal(saved.settings.deviceName, 'Successful change'); assert.equal(service.state.hosts[0].address, 'original.invalid');
});

for (const operation of ['writeFile', 'rename']) test(`a real persistence ${operation} failure never commits staged settings`, async t => {
  const { service, options, file } = await fixture(t), before = configuration(service), stored = await fs.readFile(file, 'utf8'), original = fs[operation].bind(fs);
  t.mock.method(fs, operation, async (...args) => {
    if (operation === 'rename' ? args[1] === file : path.dirname(args[0]) === path.dirname(file) && path.basename(args[0]).startsWith('state-')) throw new Error('Injected filesystem failure');
    return original(...args);
  });
  await assert.rejects(service.updateSettings({ deviceName: 'Uncommitted' }), /Injected filesystem failure/);
  assert.deepEqual(configuration(service), before); assert.equal(await fs.readFile(file, 'utf8'), stored); assert.equal(service.configurationSaving, false);
  t.mock.restoreAll(); await service.persist(); assert.equal(await fs.readFile(file, 'utf8'), stored);
  const restarted = new DriftService(options); await restarted.initialized; assert.deepEqual(configuration(restarted), before);
});

test('a disk write queued behind a successful staged edit retains the committed host change', async t => {
  const { service, id, file } = await fixture(t), persist = service.persist.bind(service);
  let release, began; service.writeChain = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { began = resolve; });
  service.persist = (...args) => { began(); return persist(...args); };
  const edit = service.saveHost({ id, name: 'Committed name' }); await started; const followingWrite = persist();
  assert.equal(service.state.hosts[0].name, 'Original'); release(); await Promise.all([edit, followingWrite]);
  assert.equal(service.state.hosts[0].name, 'Committed name'); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).manualHosts[0].name, 'Committed name');
});

test('pending configuration writes block access setup and discovery until the existing mutation queue drains', async t => {
  const { service, id } = await fixture(t), persist = service.persist.bind(service);
  let began, release; const started = new Promise(resolve => { began = resolve; }), pending = new Promise(resolve => { release = resolve; });
  service.persist = async (...args) => { began(); await pending; return persist(...args); };
  const saving = service.saveHost({ id, name: 'Saved name' }); await started;
  for (const action of [() => service.refreshHosts(), () => service.probeHosts(), () => service.configureAccess({ hostId: id, mode: 'saved', password: 'fixture-only' }), () => service.forgetPassword(id)]) await assert.rejects(action(), /settings to finish saving/);
  let drained = false; const drain = service.shelfMutation.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  release(); await saving; await drain; assert.equal(drained, true); assert.equal(service.configurationSaving, false);
});
