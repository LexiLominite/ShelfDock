'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DriftService } = require('../desktop/service.cjs');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drift-service-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home'); const data = path.join(directory, 'data');
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
  await fs.mkdir(path.join(home, '.config', 'waveterm'), { recursive: true });
  const calls = [];
  const executor = async (command, args, config) => {
    calls.push({ command, args, config });
    if (options.executor) { const result = await options.executor(command, args, config); if (result !== undefined) return result; }
    if (command === 'ssh' && args[0] === '-V') return { stdout: '', stderr: 'OpenSSH_9.9' };
    if (command === 'ssh' && args[0] === '-G') {
      const alias = args[1]; const config = (options.aliases || {})[alias] || { hostname: alias, user: 'local-default', port: 22 };
      return { stdout: Object.entries(config).map(([key, value]) => key + ' ' + value).join('\n'), stderr: '' };
    }
    if (command === 'tailscale' || command.endsWith('/Tailscale')) return { stdout: JSON.stringify(options.tailscale || { Self: {}, Peer: {} }), stderr: '' };
    if (command === 'ssh' && args.at(-1) === 'echo DRIFT_READY') return { stdout: 'DRIFT_READY\n', stderr: '' };
    if (command === 'ssh') return { stdout: '\nDRIFT_DEST=/home/me/Desktop/Drift-test\n', stderr: '' };
    if (command === 'scp') return { stdout: '', stderr: '' };
    throw new Error('Unexpected execution: ' + command);
  };
  const service = new DriftService({ dataDir: data, homeDir: home, execFile: executor, platform: 'linux', onChange: options.onChange || (() => {}) });
  await service.getState(); return { service, directory, home, data, calls, executor };
}

async function readyHost(service, extra = {}) {
  const state = await service.saveHost({ name: 'Test machine', address: '192.168.1.22', user: 'me', identityFile: '~/.ssh/test_key', ...extra });
  const id = state.hosts.find(host => host.name === (extra.name || 'Test machine')).id;
  await service.probeHosts(); return id;
}

test('discovery reads Wave and SSH Includes, preserves LAN/Tailscale routes, excludes offline, self, and Sync-only peers', async t => {
  const tailscale = { Self: { TailscaleIPs: ['100.1.1.1'] }, Peer: {
    spark: { HostName: 'spark', TailscaleIPs: ['100.64.1.20'], Online: true },
    offline: { HostName: 'offline', TailscaleIPs: ['100.2.2.2'], Online: false },
    online: { HostName: 'new-machine', TailscaleIPs: ['100.3.3.3'], Online: true },
    sync: { HostName: 'nvsync-client', TailscaleIPs: ['100.4.4.4'], Online: true },
    self: { HostName: 'this-machine', TailscaleIPs: ['100.1.1.1'], Online: true }
  } };
  const { service, home, data } = await fixture(t, { tailscale, aliases: {
    SparkLAN: { hostname: 'spark.local', user: 'example', port: 22, identityfile: '~/.ssh/spark_key' },
    SparkTail: { hostname: '100.64.1.20', user: 'example', port: 22, identityfile: '~/.ssh/spark_key' }
  } });
  await fs.writeFile(path.join(home, '.ssh', 'config'), 'Include "profiles/*.conf"\nHost * !secret\n  ServerAliveInterval 30\n');
  await fs.mkdir(path.join(home, '.ssh', 'profiles'));
  await fs.writeFile(path.join(home, '.ssh', 'profiles', 'spark.conf'), 'Host SparkLAN SparkTail # comment\nInclude ../config\n');
  await fs.writeFile(path.join(home, '.config', 'waveterm', 'connections.json'), JSON.stringify({
    'example@SparkLAN': { 'conn:wshenabled': true },
    'example@SparkTail': { 'conn:wshenabled': true, 'ssh:password': 'DO-NOT-PERSIST-ME' },
    Direct: { 'ssh:hostname': '192.168.0.9', 'ssh:user': 'direct', 'ssh:port': '2222' }
  }));
  const state = await service.refreshHosts();
  assert.equal(state.hosts.filter(host => host.user === 'example').length, 2);
  assert.equal(state.hosts.find(host => host.address === 'spark.local').route, 'lan');
  assert.equal(state.hosts.find(host => host.address === '100.64.1.20').route, 'tailscale');
  assert.equal(state.hosts.find(host => host.address === '100.64.1.20').source, 'Wave');
  assert.equal(state.hosts.find(host => host.name === 'new-machine').user, '');
  assert.equal(state.hosts.find(host => host.name === 'new-machine').status, 'auth-required');
  assert.equal(state.hosts.find(host => host.address === '192.168.0.9').port, 2222);
  assert.ok(!state.hosts.some(host => ['100.2.2.2', '100.4.4.4', '100.1.1.1'].includes(host.address)));
  assert.ok(state.discovery.warnings.some(text => text.includes('NVIDIA Sync')));
  await service.updateSettings({ sensitivity: 'strong' });
  assert.ok(!JSON.stringify(state).includes('DO-NOT-PERSIST-ME'));
  assert.ok(!(await fs.readFile(path.join(data, 'state.json'), 'utf8')).includes('DO-NOT-PERSIST-ME'));
});

test('manual machines validate injection attempts and persist without changing SSH/Wave files', async t => {
  const { service, home, data, executor } = await fixture(t);
  const configFile = path.join(home, '.ssh', 'config'); await fs.writeFile(configFile, '# untouched\n');
  for (const invalid of [{ address: '-oProxyCommand=evil' }, { address: 'host; touch nope' }, { user: 'me;cmd' }, { port: 0 }, { identityFile: 'relative-key' }, { destination: 'Desktop' }, { destination: '~/Desktop\ncmd' }]) {
    await assert.rejects(service.saveHost({ name: 'test', address: 'host.local', user: 'me', ...invalid }));
  }
  const state = await service.saveHost({ name: 'My machine', address: 'host.local', user: 'me', destination: "~/Desktop/Folder with ' quote" });
  assert.equal(state.hosts[0].destination, "~/Desktop/Folder with ' quote");
  assert.equal(await fs.readFile(configFile, 'utf8'), '# untouched\n');
  assert.equal((await fs.stat(path.join(data, 'state.json'))).mode & 0o777, 0o600);
  const restored = new DriftService({ dataDir: data, homeDir: home, execFile: executor, platform: 'linux' });
  assert.equal((await restored.getState()).hosts[0].name, 'My machine');
  await restored.removeHost(state.hosts[0].id);
  assert.equal((await restored.getState()).hosts.length, 0);
});

test('probe distinguishes authentication/trust failures from offline devices without bypassing verification', async t => {
  const { service, calls } = await fixture(t, { executor: async (command, args) => {
    if (command === 'ssh' && args.at(-1) === 'echo DRIFT_READY') {
      const error = new Error('ssh failed'); error.stderr = args.includes('100.1.1.2') ? 'Host key verification failed.' : 'Connection refused'; throw error;
    }
  } });
  await service.saveHost({ name: 'Unknown trust', address: '100.1.1.2', user: 'me' });
  await service.saveHost({ name: 'Offline', address: '100.1.1.3', user: 'me' });
  const state = await service.probeHosts();
  assert.equal(state.hosts.find(host => host.name === 'Unknown trust').status, 'auth-required');
  assert.equal(state.hosts.find(host => host.name === 'Offline').status, 'offline');
  for (const call of calls.filter(call => call.command === 'ssh' && call.args[0] !== '-V')) {
    assert.ok(call.args.includes('StrictHostKeyChecking=yes'));
    assert.ok(call.args.includes('BatchMode=yes'));
    assert.ok(!call.args.includes('StrictHostKeyChecking=no'));
  }
});

test('file and text shelf is durable, deduplicates files, and only deletes text staged by the application', async t => {
  const { service, directory, data, executor } = await fixture(t);
  const file = path.join(directory, 'report.txt'); await fs.writeFile(file, 'user content');
  await service.enqueueFiles([file, file]);
  let state = await service.enqueueText('a useful note\nsecond line');
  assert.equal(state.items.length, 2); assert.equal(state.items[1].kind, 'text');
  assert.equal(await fs.readFile(state.items[1].path, 'utf8'), 'a useful note\nsecond line');
  assert.equal((await fs.stat(state.items[1].path)).mode & 0o777, 0o600);
  const staged = state.items[1].path;
  const restored = new DriftService({ dataDir: data, execFile: executor, platform: 'linux' });
  assert.equal((await restored.getState()).items.length, 2);
  await restored.clearItems();
  restored.clock = () => Date.now() + 10001; await restored.expireClearUndo();
  await assert.rejects(fs.stat(staged), { code: 'ENOENT' });
  assert.equal(await fs.readFile(file, 'utf8'), 'user content');
  state.items.push({ id: 'not-real' });
  assert.equal((await service.getState()).items.length, 2, 'state snapshots are cloned');
});

test('deliberate send creates a unique Desktop batch, quotes hostile paths, records receipt and retains shelf', async t => {
  const updates = [];
  const { service, directory, calls } = await fixture(t, { onChange: state => updates.push(state) });
  const id = await readyHost(service, { destination: "~/Desktop/A's $(touch nope)" });
  const file = path.join(directory, "report's $(touch nope).txt"); await fs.writeFile(file, 'safe');
  await service.enqueueFiles([file]); await service.enqueueText('hello');
  const before = await service.getState();
  assert.ok(!calls.some(call => call.command === 'scp'), 'enqueue never initiates a transfer');
  const state = await service.send({ hostId: id, itemIds: before.items.map(item => item.id) });
  assert.equal(state.history[0].status, 'sent'); assert.equal(state.items.length, 2);
  assert.equal(state.history[0].destination, '/home/me/Desktop/Drift-test');
  const mkdir = calls.find(call => call.command === 'ssh' && call.args.at(-1).includes('umask'));
  assert.ok(mkdir.args.at(-1).includes("'Desktop/A'\\''s $(touch nope)'"));
  assert.match(mkdir.args.at(-1), /mkdir -- "\$target"/);
  const transfers = calls.filter(call => call.command === 'scp'); assert.equal(transfers.length, 2);
  assert.ok(transfers[0].args.includes(file));
  assert.ok(transfers[0].args.at(-1).includes("report'\\''s $(touch nope).txt'"));
  assert.ok(transfers[0].args.includes('-O'));
  assert.ok(transfers[0].args.includes('StrictHostKeyChecking=yes'));
  assert.ok(updates.some(update => update.history[0] && update.history[0].message.startsWith('Sending 1 of 2')));
});

test('same filenames have separate destinations and partial failures are explicit', async t => {
  let scpCount = 0;
  const { service, directory, calls } = await fixture(t, { executor: async (command) => {
    if (command === 'scp' && ++scpCount === 2) throw new Error('network interrupted');
  } });
  const id = await readyHost(service);
  await fs.mkdir(path.join(directory, 'one')); await fs.mkdir(path.join(directory, 'two'));
  const first = path.join(directory, 'one', 'same.txt'); const second = path.join(directory, 'two', 'same.txt');
  await fs.writeFile(first, 'first'); await fs.writeFile(second, 'second');
  const queue = await service.enqueueFiles([first, second]);
  const state = await service.send({ hostId: id, itemIds: queue.items.map(item => item.id) });
  assert.equal(state.history[0].status, 'failed'); assert.equal(state.items.length, 2);
  assert.ok(state.history[0].message.includes('Some files may already be'));
  assert.ok(calls.filter(call => call.command === 'scp')[1].args.at(-1).includes('same (2).txt'));
});

test('folders with symlinks are refused before any remote transfer', async t => {
  const { service, directory, calls } = await fixture(t); const id = await readyHost(service);
  const folder = path.join(directory, 'folder'); await fs.mkdir(folder);
  const outside = path.join(directory, 'outside.txt'); await fs.writeFile(outside, 'outside');
  await fs.symlink(outside, path.join(folder, 'link.txt'));
  const queue = await service.enqueueFiles([folder]);
  const state = await service.send({ hostId: id, itemIds: queue.items.map(item => item.id) });
  assert.equal(state.history[0].status, 'failed'); assert.match(state.history[0].message, /symbolic links/);
  assert.ok(!calls.some(call => call.command === 'scp'));
});

test('concurrent sends are prevented', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const { service, directory } = await fixture(t, { executor: async command => { if (command === 'scp') { await waiting; return { stdout: '', stderr: '' }; } } });
  const file = path.join(directory, 'file.txt'); await fs.writeFile(file, 'text');
  const queue = await service.enqueueFiles([file]);
  const linuxID = await readyHost(service);
  const sending = service.send({ hostId: linuxID, itemIds: [queue.items[0].id] });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(service.send({ hostId: linuxID, itemIds: [queue.items[0].id] }), /already running/);
  await assert.rejects(service.clearItems(), /current transfer/);
  release(); assert.equal((await sending).history[0].status, 'sent');
});

test('saved discovered edits and removed hosts survive scans', async t => {
  const { service, home } = await fixture(t, { aliases: { Remote: { hostname: '192.168.1.8', user: 'me', port: 22 } } });
  await fs.writeFile(path.join(home, '.ssh', 'config'), 'Host Remote\n  HostName 192.168.1.8\n  User me\n');
  let state = await service.refreshHosts(); const id = state.hosts[0].id;
  await service.saveHost({ id, name: 'Friendly name', destination: '~/Desktop/Incoming' });
  state = await service.refreshHosts();
  assert.equal(state.hosts[0].name, 'Friendly name'); assert.equal(state.hosts[0].destination, '~/Desktop/Incoming');
  await service.removeHost(id); state = await service.refreshHosts(); assert.equal(state.hosts.length, 0);
});


test('Windows destinations use encoded literal paths, redirected Desktop, and SFTP-safe arguments', async t => {
  const { service, directory, calls } = await fixture(t, { executor: async (command, args) => {
    if (command === 'ssh' && args.at(-1).startsWith('powershell.exe')) return { stdout: 'DRIFT_DEST=C:/Users/me/OneDrive/Desktop/Drift-test\r\n', stderr: '' };
  } });
  const id = await readyHost(service, { os: 'windows', destination: '~/Desktop' });
  const file = path.join(directory, "report's & hello.txt"); await fs.writeFile(file, 'windows text');
  const queue = await service.enqueueFiles([file]);
  const state = await service.send({ hostId: id, itemIds: queue.enqueuedItemIds });
  assert.equal(state.history[0].status, 'sent');
  const command = calls.find(call => call.command === 'ssh' && call.args.at(-1).startsWith('powershell.exe')).args.at(-1);
  const decoded = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.ok(decoded.includes("GetFolderPath('Desktop')"));
  assert.ok(decoded.includes('Test-Path -LiteralPath'));
  const scp = calls.find(call => call.command === 'scp');
  assert.ok(!scp.args.includes('-O'));
  assert.equal(scp.args.at(-1), "me@192.168.1.22:C:/Users/me/OneDrive/Desktop/Drift-test/report's & hello.txt");
  const hostile = service.windowsDestinationCommand("C:/Users/me/A'; Write-Output bad; #", 'batch');
  assert.ok(Buffer.from(hostile.split(' ').at(-1), 'base64').toString('utf16le').includes("'C:/Users/me/A''; Write-Output bad; #'"));
});

test('old OpenSSH clients refuse Windows SFTP transfer and invalid Windows filenames are rejected', async t => {
  const { service, directory } = await fixture(t, { executor: async (command, args) => {
    if (command === 'ssh' && args[0] === '-V') return { stdout: '', stderr: 'OpenSSH_8.6' };
  } });
  const id = await readyHost(service, { os: 'windows' });
  const file = path.join(directory, 'bad:name.txt'); await fs.writeFile(file, 'text');
  const queue = await service.enqueueFiles([file]);
  await assert.rejects(service.send({ hostId: id, itemIds: queue.enqueuedItemIds }), /OpenSSH 9 or newer/);
  service.sshMajor = 9;
  const state = await service.send({ hostId: id, itemIds: queue.enqueuedItemIds });
  assert.equal(state.history[0].status, 'failed'); assert.match(state.history[0].message, /valid filename on Windows/);
});

test('per-operation enqueue IDs include held duplicates and exclude unrelated shelf additions', async t => {
  const { service, directory } = await fixture(t);
  const file = path.join(directory, 'file.txt'); await fs.writeFile(file, 'text');
  const initial = await service.enqueueFiles([file]);
  const concurrent = await Promise.all([service.enqueueFiles([file]), service.enqueueText('unrelated note')]);
  assert.deepEqual(concurrent[0].enqueuedItemIds, initial.enqueuedItemIds);
  assert.equal(concurrent[1].enqueuedItemIds.length, 1);
  assert.ok(!concurrent[0].enqueuedItemIds.includes(concurrent[1].enqueuedItemIds[0]));
  assert.equal((await service.getState()).items.length, 2);
});

test('SSH aliases retain configured key/agent behavior instead of forcing the first default key', async t => {
  const { service, home, calls } = await fixture(t, { aliases: { Working: { hostname: 'host.local', user: 'me', port: 22, identityfile: '~/.ssh/id_rsa' } } });
  await fs.writeFile(path.join(home, '.ssh', 'config'), 'Host Working\n User me\n');
  const state = await service.refreshHosts();
  assert.equal(state.hosts[0].identityFile, '');
  await service.probeHosts();
  const probe = calls.find(call => call.command === 'ssh' && call.args.at(-1) === 'echo DRIFT_READY');
  assert.ok(!probe.args.includes('IdentitiesOnly=yes'));
  assert.ok(!probe.args.includes('-i'));
});

test('LAN routes do not inherit offline Tailscale status even for the same machine', async t => {
  const { service, home } = await fixture(t, { tailscale: { Self: {}, Peer: { spark: { HostName: 'spark.local', DNSName: 'spark.tailnet.ts.net.', TailscaleIPs: ['100.64.1.20'], Online: false } } } });
  await fs.writeFile(path.join(home, '.config', 'waveterm', 'connections.json'), JSON.stringify({ LAN: { 'ssh:hostname': 'spark.local', 'ssh:user': 'me' }, Tail: { 'ssh:hostname': '100.64.1.20', 'ssh:user': 'me' } }));
  const state = await service.refreshHosts();
  const lan = state.hosts.find(host => host.name === 'LAN'); const tail = state.hosts.find(host => host.name === 'Tail');
  assert.equal(lan.route, 'lan'); assert.equal(lan.status, 'unknown'); assert.equal(lan.online, undefined);
  assert.equal(tail.route, 'tailscale'); assert.equal(tail.status, 'offline'); assert.equal(tail.online, false);
});

test('explicit Wave self destinations remain available while automatic self discovery is excluded', async t => {
  const { service, home } = await fixture(t, { tailscale: { Self: { TailscaleIPs: ['100.64.1.21'] }, Peer: {} } });
  await fs.writeFile(path.join(home, '.config', 'waveterm', 'connections.json'), JSON.stringify({ MyMac: { 'ssh:hostname': '100.64.1.21', 'ssh:user': 'me' } }));
  const state = await service.refreshHosts();
  assert.equal(state.hosts.length, 1); assert.equal(state.hosts[0].name, 'MyMac');
});

test('case-insensitive top-level collisions receive unique destination filenames', async t => {
  const { service, directory, calls } = await fixture(t); const id = await readyHost(service);
  await fs.mkdir(path.join(directory, 'one')); await fs.mkdir(path.join(directory, 'two'));
  const first = path.join(directory, 'one', 'Test.txt'); const second = path.join(directory, 'two', 'test.txt');
  await fs.writeFile(first, 'one'); await fs.writeFile(second, 'two');
  const queue = await service.enqueueFiles([first, second]);
  const state = await service.send({ hostId: id, itemIds: queue.enqueuedItemIds });
  assert.equal(state.history[0].status, 'sent');
  assert.deepEqual(state.history[0].itemIds, queue.enqueuedItemIds);
  assert.ok(calls.filter(call => call.command === 'scp')[1].args.at(-1).includes('test (2).txt'));
});

test('Windows folder child names are validated before creating a remote batch', async t => {
  const { service, directory, calls } = await fixture(t); const id = await readyHost(service, { os: 'windows' });
  const folder = path.join(directory, 'folder'); await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'CON.txt'), 'invalid windows name');
  const queue = await service.enqueueFiles([folder]);
  const state = await service.send({ hostId: id, itemIds: queue.enqueuedItemIds });
  assert.equal(state.history[0].status, 'failed'); assert.match(state.history[0].message, /filename on Windows/);
  assert.ok(!calls.some(call => call.command === 'ssh' && call.args.at(-1).startsWith('powershell.exe')));
});

test('refresh waits for active probes so completion statuses stay attached to current hosts', async t => {
  let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { service, home } = await fixture(t, { executor: async (command, args) => {
    if (command === 'ssh' && args.at(-1) === 'echo DRIFT_READY') { entered(); await gate; return { stdout: 'DRIFT_READY', stderr: '' }; }
  } });
  await fs.writeFile(path.join(home, '.config', 'waveterm', 'connections.json'), JSON.stringify({ Machine: { 'ssh:hostname': 'machine.local', 'ssh:user': 'me' } }));
  await service.refreshHosts();
  const probing = service.probeHosts(); await started;
  const scanning = service.refreshHosts(); release(); await Promise.all([probing, scanning]);
  assert.equal((await service.getState()).hosts[0].status, 'ready');
});

test('discovery preserves checked failures until a new check and offline peers override cached readiness', async t => {
  let reachable = false;
  const tailscale = {Self: {}, Peer: {peer: {HostName: 'machine', TailscaleIPs: ['100.64.20.22'], Online: true}}};
  const {service, home} = await fixture(t, {tailscale, executor: async (command,args) => {
    if(command === 'ssh' && args.at(-1) === 'echo DRIFT_READY' && !reachable) { const e=new Error('Connection refused');e.stderr='Connection refused';throw e; }
  }});
  await fs.writeFile(path.join(home,'.config/waveterm/connections.json'),JSON.stringify({Machine:{'ssh:hostname':'100.64.20.22','ssh:user':'me'}}));
  await service.refreshHosts();await service.probeHosts();
  const scanned=await service.refreshHosts();assert.equal(scanned.hosts[0].status,'offline');assert.match(scanned.hosts[0].error,/refused/);
  reachable=true;await service.probeHosts();assert.equal((await service.getState()).hosts[0].status,'ready');
  tailscale.Peer.peer.Online=false;assert.equal((await service.refreshHosts()).hosts[0].status,'offline');
});

test('multi-machine transfer runs at most two destinations concurrently, preserves exact items, and separates failures', async t => {
  let release; let entered; let active = 0; let maximum = 0; let transfers = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const running = new Promise(resolve => { entered = resolve; });
  const { service, calls } = await fixture(t, { executor: async (command, args) => {
    if (command !== 'scp') return undefined;
    transfers++; active++; maximum = Math.max(maximum, active);
    if (active === 2) entered();
    try { await gate; if (args.at(-1).includes('two.invalid')) throw new Error('Connection reset by peer'); return { stdout: '', stderr: '' }; }
    finally { active--; }
  } });
  for (const name of ['one', 'two', 'three', 'offline']) await readyHost(service, { name, address: name + '.invalid' });
  service.state.hosts.find(host => host.name === 'offline').status = 'offline';
  await service.enqueueText('first selected item'); await service.enqueueText('second selected item'); await service.enqueueText('unselected item');
  const before = await service.getState(); const itemIds = before.items.slice(0, 2).map(item => item.id); const hostIds = before.hosts.map(host => host.id);
  calls.length = 0;
  const sending = service.sendMany({ hostIds, itemIds }); await running;
  assert.equal(service.transferring, true); assert.equal(maximum, 2);
  await assert.rejects(service.sendMany({ hostIds, itemIds }), /already running/);
  await assert.rejects(service.send({ hostId: hostIds[0], itemIds }), /already running/);
  await assert.rejects(service.removeItem(itemIds[0]), /transfer/);
  await assert.rejects(service.saveHost({ id: hostIds[0], name: 'edited' }), /transfer/);
  await assert.rejects(service.refreshHosts(), /transfer/);
  await service.enqueueText('arrived after confirmation');
  release(); const state = await sending;
  assert.equal(service.transferring, false); assert.equal(maximum, 2); assert.equal(state.items.length, 4);
  assert.equal(state.history.length, 4); assert.equal(state.history.filter(receipt => receipt.status === 'sent').length, 2);
  assert.equal(state.history.filter(receipt => receipt.status === 'failed').length, 2);
  for (const receipt of state.history) assert.deepEqual(receipt.itemIds, itemIds);
  assert.equal(new Set(state.history.map(receipt => receipt.batchId)).size, 1);
  assert.equal(calls.filter(call => call.command === 'ssh' && call.args.at(-1) === 'echo DRIFT_READY').length, 3);
  assert.equal(transfers, 5); // Two files to each successful target; the other fails on its first file.
});

test('multi-machine preflight rejects stale or duplicate selections before starting a transfer', async t => {
  const { service, calls } = await fixture(t);
  const hostId = await readyHost(service); await service.enqueueText('selected');
  const itemId = (await service.getState()).items[0].id; calls.length = 0;
  for (const payload of [
    { hostIds: [hostId, hostId], itemIds: [itemId] },
    { hostIds: [hostId], itemIds: [itemId, itemId] },
    { hostIds: [hostId, 'stale-host'], itemIds: [itemId] },
    { hostIds: [hostId], itemIds: ['stale-item'] },
    { hostIds: [], itemIds: [itemId] }
  ]) await assert.rejects(service.sendMany(payload));
  assert.equal(calls.length, 0); assert.equal(service.transferring, false); assert.equal((await service.getState()).history.length, 0);
});

test('multi-machine sending waits for an already active probe before checking readiness', async t => {
  let hold = false; let release; let entered;
  const gate = new Promise(resolve => { release = resolve; }); const probing = new Promise(resolve => { entered = resolve; });
  const { service, calls } = await fixture(t, { executor: async (command, args) => {
    if (hold && command === 'ssh' && args.at(-1) === 'echo DRIFT_READY') { entered(); await gate; return { stdout: 'DRIFT_READY\n', stderr: '' }; }
    return undefined;
  } });
  const id = await readyHost(service); await service.enqueueText('send after the active probe');
  const itemIds = (await service.getState()).items.map(item => item.id);
  hold = true; calls.length = 0;
  const checking = service.probeHosts(); await probing;
  assert.equal(service.state.hosts[0].status, 'checking');
  const sending = service.sendMany({ hostIds: [id], itemIds });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.transferring, true); assert.equal(service.state.history.length, 0); assert.equal(calls.filter(call => call.command === 'scp').length, 0);
  release(); await checking;
  const state = await sending; assert.equal(state.history[0].status, 'sent'); assert.equal(service.transferring, false);
});

test('multi-machine preflight uses the final host list after an in-flight scan replaces it', async t => {
  let hold = false; let release; let entered;
  const gate = new Promise(resolve => { release = resolve; }); const scanning = new Promise(resolve => { entered = resolve; });
  const { service, calls } = await fixture(t, { executor: async (command) => {
    if (hold && command === 'tailscale') { entered(); await gate; return { stdout: '{"Peer":{}}', stderr: '' }; }
    return undefined;
  } });
  const id = await readyHost(service); await service.enqueueText('must not go to a vanished target');
  const itemIds = (await service.getState()).items.map(item => item.id);
  // Model a route whose discovery source disappeared while a scan was running.
  service.manualHosts = []; hold = true; calls.length = 0;
  const refresh = service.refreshHosts(); await scanning;
  const sending = service.sendMany({ hostIds: [id], itemIds });
  const rejected = assert.rejects(sending, /no longer available/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.transferring, true); assert.equal(calls.filter(call => call.command === 'scp').length, 0);
  release(); await refresh; await rejected;
  assert.equal(calls.filter(call => call.command === 'scp').length, 0); assert.equal(service.transferring, false); assert.equal(service.state.hosts.length, 0);
});

test('a Mac installation lock acquired after discovery was queued blocks resumed discovery and probing', async t => {
  const { service, calls } = await fixture(t); service.state.environment.sshAvailable = true;
  // Both methods yield at their initialized promise before reserving scan/probe ownership.
  const refreshing = service.refreshHosts(); const probing = service.probeHosts(); service.macInstallation = true;
  await assert.rejects(refreshing, /Mac installation/); await assert.rejects(probing, /Mac installation/);
  assert.equal(calls.length, 0); assert.equal(service.scanPromise, null); assert.equal(service.probePromise, null);
  await assert.rejects(service.saveHost({ name: 'Must not be saved', address: 'example.invalid', user: 'fixture' }), /Mac installation/);
  await assert.rejects(service.updateSettings({ shakeEnabled: false }), /Mac installation/); assert.equal(service.state.hosts.length, 0); assert.equal(service.state.settings.shakeEnabled, true);
  service.macInstallation = false;
});

test('discovery rechecks a Mac installation lock after waiting for the other discovery operation', async t => {
  for (const kind of ['refresh', 'probe']) {
    const { service, calls } = await fixture(t); service.state.environment.sshAvailable = true;
    let release; const gate = new Promise(resolve => { release = resolve; });
    if (kind === 'refresh') service.probePromise = gate; else service.scanPromise = gate;
    const pending = kind === 'refresh' ? service.refreshHosts() : service.probeHosts();
    await new Promise(resolve => setImmediate(resolve)); service.macInstallation = true;
    if (kind === 'refresh') service.probePromise = null; else service.scanPromise = null;
    release(); await assert.rejects(pending, /Mac installation/); assert.equal(calls.length, 0); service.macInstallation = false;
  }
});
