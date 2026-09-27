'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PasswordAuth, PasswordSession, endpointKey, knownHostKeys, bootstrapCommand } = require('../desktop/password-auth.cjs');
const { DriftService } = require('../desktop/service.cjs');

const type = Buffer.from('ssh-ed25519'); const length = Buffer.alloc(4); length.writeUInt32BE(type.length);
const hostKey = Buffer.concat([length, type, Buffer.alloc(32, 7)]);
const publicKey = 'ssh-ed25519 ' + hostKey.toString('base64') + ' dropharbor-01234567-0123-0123-0123-0123456789ab';
const host = { id: 'manual-test', name: 'Test', address: 'test.invalid', port: 22, user: 'tester', sshAlias: '', os: 'posix', source: 'Manual', destination: '~/Desktop' };
const secret = 'never-write-this-password';
function encryption() {
  const key = crypto.randomBytes(32);
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString(value) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); }, decryptString(value) { const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); } };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dropharbor-auth-test-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const commands = []; const connections = []; const sessions = []; const control = { ...options };
  const run = async (command, args) => {
    commands.push({ command, args });
    if (command === 'ssh' && args.includes('-G')) return { stdout: `hostname ${host.address}\nuserknownhostsfile "${path.join(directory, 'known hosts')}"\nglobalknownhostsfile none\n${control.config || ''}`, stderr: '' };
    if (command === 'ssh-keygen' && args.includes('-F')) return { stdout: control.knownHosts === undefined ? `${host.address} ssh-ed25519 ${hostKey.toString('base64')}\n` : control.knownHosts, stderr: '' };
    if (command === 'ssh-keygen' && args.includes('-t')) { const file = args[args.indexOf('-f') + 1]; await fs.writeFile(file, 'MOCK PRIVATE KEY'); await fs.writeFile(file + '.pub', publicKey + '\n'); return { stdout: '', stderr: '' }; }
    if (command === 'ssh' && args.includes('-V')) return { stdout: '', stderr: 'OpenSSH_9.9' };
    if (command === 'ssh' && args.at(-1) === 'echo DRIFT_READY') return { stdout: 'DRIFT_READY\n', stderr: '' };
    if (command === 'tailscale') return { stdout: '{"Peer":{}}', stderr: '' };
    throw new Error('Unexpected test command');
  };
  class Client extends EventEmitter {
    connect(config) {
      connections.push(config);
      queueMicrotask(() => {
        if (!config.hostVerifier(control.presentedKey || hostKey)) return this.emit('error', Object.assign(new Error('untrusted'), { level: 'handshake' }));
        if (control.authFailure || (config.privateKey && control.keyFailure)) return this.emit('error', Object.assign(new Error(secret), { level: 'client-authentication' }));
        this.emit('ready');
      });
    }
    destroy() { this.destroyed = true; }
    end() { this.ended = true; }
    exec(command, callback) {
      sessions.push(command);
      const channel = new EventEmitter(); channel.stderr = new EventEmitter(); channel.destroy = () => {};
      callback(null, channel);
      queueMicrotask(() => { channel.emit('data', Buffer.from(command.includes('DRIFT_KEY_INSTALLED') ? 'DRIFT_KEY_INSTALLED\n' : 'DRIFT_READY\n')); channel.stderr.emit('data', Buffer.from(secret)); channel.emit('close', command.includes('DRIFT_KEY_INSTALLED') && control.installFailure ? 1 : 0); });
    }
  }
  const safeStorage = options.safeStorage || encryption();
  const auth = new PasswordAuth({ dataDir: path.join(directory, 'data'), homeDir: directory, platform: options.platform || 'linux', safeStorage, run, Client });
  await auth.initialized;
  return { auth, directory, commands, connections, sessions, control, run, safeStorage, Client };
}

test('vault stores only OS-encrypted ciphertext, binds exact endpoint and alias, and survives restart', async t => {
  const { auth, directory, safeStorage, run, Client } = await fixture(t);
  await auth.save(host, secret);
  const data = await fs.readFile(auth.file, 'utf8'); assert.ok(!data.includes(secret)); assert.ok(!data.includes(host.address));
  assert.equal((await fs.stat(auth.file)).mode & 0o777, 0o600);
  assert.equal(await auth.password(host), secret);
  for (const change of [{ user: 'other' }, { port: 2222 }, { address: 'other.invalid' }, { sshAlias: 'different-route' }]) assert.equal(auth.metadata({ ...host, ...change }).hasSavedPassword, false);
  const loaded = new PasswordAuth({ dataDir: path.join(directory, 'data'), homeDir: directory, platform: 'linux', safeStorage, run, Client });
  assert.equal(await loaded.password(host), secret);
  await loaded.forget(host); assert.equal(loaded.metadata(host).hasSavedPassword, false);
});

test('Linux plaintext/unknown backends and locked OS keychains cannot save a password', async t => {
  for (const backend of ['basic_text', 'unknown', undefined]) {
    const { auth } = await fixture(t, { safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend } });
    assert.equal(auth.storageAvailable(), false); await assert.rejects(auth.save(host, secret), /Secure password storage/);
  }
  const { auth } = await fixture(t, { safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(auth.save(host, secret), /Secure password storage/);
});

test('host trust supports hashed lookup, nonstandard ports, and HostKeyAlias without port decoration', async t => {
  const { auth, commands, connections, control } = await fixture(t, { knownHosts: `# found host\n|1|hash|hash ssh-ed25519 ${hostKey.toString('base64')}\n` });
  await auth.withPassword({ ...host, port: 2222 }, session => session.exec('echo DRIFT_READY'), secret);
  assert.ok(commands.some(call => call.command === 'ssh-keygen' && call.args.includes('[test.invalid]:2222')));
  assert.deepEqual(connections[0].authHandler, ['password']); assert.deepEqual(connections[0].algorithms.serverHostKey, ['ssh-ed25519']);
  assert.ok(!JSON.stringify(commands).includes(secret));
  control.config = 'hostkeyalias verified-endpoint';
  await auth.withPassword({ ...host, port: 2222, sshAlias: 'alias' }, session => session.exec('echo DRIFT_READY'), secret);
  assert.equal(commands.filter(call => call.command === 'ssh-keygen').at(-1).args[1], 'verified-endpoint');
  assert.ok(commands.some(call => call.args.includes('HostName=test.invalid')));
});

test('unknown, changed, revoked, certificate-only and disabled host keys fail before password authentication', async t => {
  const key = hostKey.toString('base64');
  for (const knownHosts of ['', `@revoked test.invalid ssh-ed25519 ${key}`, `test.invalid ssh-ed25519 ${key}\n@revoked test.invalid ssh-ed25519 ${key}`, `@cert-authority test.invalid ssh-ed25519 ${key}`]) {
    const { auth, connections } = await fixture(t, { knownHosts });
    await assert.rejects(auth.withPassword(host, () => {}, secret), /fingerprint/); assert.equal(connections.length, 0);
  }
  const changed = await fixture(t, { presentedKey: Buffer.from('other-key') });
  await assert.rejects(changed.auth.withPassword(host, () => {}, secret), /fingerprint/);
  const disabled = await fixture(t, { config: 'hostkeyalgorithms rsa-sha2-512' });
  await assert.rejects(disabled.auth.withPassword(host, () => {}, secret), /disabled algorithm/); assert.equal(disabled.connections.length, 0);
});

test('new password paths reject proxy routing and separate revocation policies without bypassing them', async t => {
  for (const config of ['proxyjump jump.invalid', 'proxycommand custom-proxy', 'knownhostscommand custom-trust', 'revokedhostkeys /path/to/revoked']) {
    const { auth, connections } = await fixture(t, { config });
    await assert.rejects(auth.withPassword(host, () => {}, secret), /direct SSH|revocation policy/); assert.equal(connections.length, 0);
  }
});

test('rejected saved passwords pause automatically across restarts, with sanitized errors', async t => {
  const { auth, control, directory, safeStorage, run, Client, connections } = await fixture(t);
  await auth.save(host, secret); control.authFailure = true;
  await assert.rejects(auth.withPassword(host, () => {}), error => error.code === 'AUTH_FAILED' && !error.message.includes(secret));
  assert.equal(auth.metadata(host).passwordPaused, true);
  await assert.rejects(auth.withPassword(host, () => {}), /attempts are paused/); assert.equal(connections.length, 1);
  const loaded = new PasswordAuth({ dataDir: path.join(directory, 'data'), homeDir: directory, platform: 'linux', safeStorage, run, Client });
  await assert.rejects(loaded.password(host), /attempts are paused/);
  await loaded.save(host, 'corrected-password'); assert.equal(loaded.metadata(host).passwordPaused, false);
});

test('one-time setup generates a private local key, verifies that specific key, and does not save the password', async t => {
  const { auth, connections, commands, sessions } = await fixture(t);
  let verified;
  const key = await auth.bootstrap(host, secret, async file => { verified = file; });
  assert.equal(key, verified); assert.equal((await fs.stat(key)).mode & 0o777, 0o600);
  assert.deepEqual(connections.map(config => config.authHandler), [['password'], ['publickey']]);
  assert.equal(connections[1].password, undefined); assert.ok(Buffer.isBuffer(connections[1].privateKey));
  assert.equal(auth.metadata(host).hasSavedPassword, false);
  assert.ok(!JSON.stringify(commands).includes(secret)); assert.ok(!sessions.join('').includes('MOCK PRIVATE KEY'));
  assert.ok(sessions[0].includes('>>')); assert.ok(sessions[0].includes('test ! -L'));
});

test('uncertain remote install and failed verification retain the local key without reporting success', async t => {
  for (const options of [{ installFailure: true }, { keyFailure: true }]) {
    const { auth } = await fixture(t, options); let committed = false;
    await assert.rejects(auth.bootstrap(host, secret, async () => { committed = true; }));
    assert.equal(committed, false);
    const keys = (await fs.readdir(path.join(auth.dataDir, 'ssh-keys'))).filter(name => name.startsWith('device-')); assert.equal(keys.length, 1);
    assert.equal(await fs.readFile(path.join(auth.dataDir, 'ssh-keys', keys[0], 'id_ed25519'), 'utf8'), 'MOCK PRIVATE KEY');
    assert.equal(auth.metadata(host).hasSavedPassword, false);
  }
});

test('Windows bootstrap includes administrator and user paths, SID ACLs, no private keys or passwords', () => {
  const command = bootstrapCommand('windows', publicKey);
  const script = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes('administrators_authorized_keys')); assert.ok(script.includes('$env:USERPROFILE')); assert.ok(script.includes('S-1-5-32-544')); assert.ok(script.includes('ReparsePoint')); assert.ok(script.includes('AppendAllText'));
  assert.ok(script.includes('$identity.Groups')); assert.ok(script.includes('$adminMember -and !$admin'));
  assert.ok(script.indexOf('filtered token') < script.indexOf('[IO.Directory]::CreateDirectory'));
  assert.ok(!script.includes(secret)); assert.ok(!script.includes('PRIVATE KEY'));
});

test('service password setup never exposes credentials in state, and endpoint edits remove their old binding', async t => {
  const { auth, run, directory } = await fixture(t);
  const service = new DriftService({ dataDir: path.join(directory, 'service'), homeDir: directory, execFile: run, platform: 'linux', passwordAuth: auth });
  let state = await service.saveHost(host); const id = state.hosts[0].id;
  state = await service.configureAccess({ hostId: id, mode: 'saved', password: secret });
  assert.equal(state.hosts[0].authMode, 'password'); assert.equal(state.hosts[0].status, 'ready'); assert.equal(state.environment.passwordStorageAvailable, true);
  assert.ok(!JSON.stringify(state).includes(secret)); assert.ok(!(await fs.readFile(path.join(service.dataDir, 'state.json'), 'utf8')).includes(secret));
  await service.saveHost({ id, address: 'changed.invalid' }); assert.equal(auth.metadata(host).hasSavedPassword, false);
  state = await service.getState(); assert.equal(state.hosts[0].authMode, 'key');
});

test('service key setup rejects concurrent setup, transfer, host edits, and scanning', async t => {
  const { auth, run, directory } = await fixture(t);
  const service = new DriftService({ dataDir: path.join(directory, 'service'), homeDir: directory, execFile: run, passwordAuth: auth });
  const state = await service.saveHost(host); const id = state.hosts[0].id;
  let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  auth.bootstrap = async () => { entered(); return new Promise(resolve => { release = () => resolve('/fake/key'); }); };
  const pending = service.configureAccess({ hostId: id, mode: 'once', password: secret }); await started;
  assert.equal(service.authenticationSetup, true);
  for (const action of [() => service.configureAccess({ hostId: id, mode: 'saved', password: secret }), () => service.saveHost({ id, name: 'Edited' }), () => service.removeHost(id), () => service.refreshHosts(), () => service.probeHosts(), () => service.send({ hostId: id, itemIds: [] })]) await assert.rejects(action(), /access setup/);
  release(); const result = await pending;
  assert.equal(service.authenticationSetup, false); assert.equal(result.hosts[0].identityFile, '/fake/key'); assert.equal(result.hosts[0].status, 'ready');
});

test('known-host parsing rejects CA entries and tracks explicit revocations', () => {
  const key = hostKey.toString('base64');
  const parsed = knownHostKeys(`@cert-authority host ssh-ed25519 ${key}\n@revoked host ssh-ed25519 ${key}\n# comment`);
  assert.equal(parsed.accepted.size, 0); assert.ok(parsed.revoked.has(key));
  assert.notEqual(endpointKey(host), endpointKey({ ...host, user: 'other' }));
});

test('retry reuses an uncertain installed public key and successful commit removes its pending marker', async t => {
  const { auth, commands, control, sessions } = await fixture(t, { keyFailure: true });
  await assert.rejects(auth.bootstrap(host, secret, async () => {}), /kept for recovery/);
  control.keyFailure = false;
  const key = await auth.bootstrap(host, secret, async () => {});
  assert.equal(commands.filter(call => call.command === 'ssh-keygen' && call.args.includes('-t')).length, 1);
  assert.equal(sessions.filter(command => command.includes('DRIFT_KEY_INSTALLED')).length, 2);
  await auth.completeBootstrap(host);
  await assert.rejects(fs.access(auth.pendingFile(host)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(key, 'utf8'), 'MOCK PRIVATE KEY');
});

test('automatic checks skip saved passwords while explicit checks use them', async t => {
  const { auth, run, directory, connections } = await fixture(t);
  const service = new DriftService({ dataDir: path.join(directory, 'service'), homeDir: directory, execFile: run, passwordAuth: auth });
  const state = await service.saveHost(host); const id = state.hosts[0].id;
  await service.configureAccess({ hostId: id, mode: 'saved', password: secret });
  service.state.environment.sshAvailable = true;
  const before = connections.length;
  await service.probeHosts({ automatic: true }); assert.equal(connections.length, before);
  await service.probeHosts(); assert.equal(connections.length, before + 1);
});

test('password SFTP copies nested files exclusively, preserves an existing destination, and rejects symlinks', async t => {
  const { directory } = await fixture(t); const nativeFS = require('node:fs');
  const source = path.join(directory, 'source'); const destination = path.join(directory, 'destination');
  await fs.mkdir(path.join(source, 'nested'), { recursive: true }); await fs.writeFile(path.join(source, 'nested', 'note.txt'), 'selected content');
  const flags = []; let ended = 0;
  const client = new EventEmitter();
  client.sftp = callback => callback(null, {
    mkdir: (target, options, callback) => nativeFS.mkdir(target, options, callback),
    createWriteStream: (target, options) => { flags.push(options.flags); return nativeFS.createWriteStream(target, options); },
    end: () => { ended++; }
  });
  const session = new PasswordSession(client);
  await session.upload(source, destination);
  assert.equal(await fs.readFile(path.join(destination, 'nested', 'note.txt'), 'utf8'), 'selected content'); assert.deepEqual(flags, ['wx']);
  await fs.writeFile(path.join(source, 'nested', 'note.txt'), 'changed content');
  await assert.rejects(session.upload(path.join(source, 'nested', 'note.txt'), path.join(destination, 'nested', 'note.txt')), /could not finish/);
  assert.equal(await fs.readFile(path.join(destination, 'nested', 'note.txt'), 'utf8'), 'selected content');
  const link = path.join(directory, 'link'); await fs.symlink(source, link);
  await assert.rejects(session.upload(link, path.join(directory, 'link-destination')), /could not finish/); assert.equal(ended, 3);
});

test('failed key-setting persistence leaves manual and discovered access unchanged and retains the retry key', async t => {
  for (const discovered of [false, true]) {
    const { auth, run, directory, commands } = await fixture(t);
    const service = new DriftService({ dataDir: path.join(directory, 'service'), homeDir: directory, execFile: run, passwordAuth: auth });
    let state = await service.saveHost({ ...host, identityFile: '~/.ssh/original-key' });
    const id = state.hosts[0].id;
    if (discovered) {
      service.state.hosts[0].source = 'Wave'; service.manualHosts = []; service.overrides = { [id]: { name: 'Existing custom name' } };
      await service.persist();
    }
    const before = await service.getState(); const manual = structuredClone(service.manualHosts); const overrides = structuredClone(service.overrides);
    const stored = await fs.readFile(path.join(service.dataDir, 'state.json'), 'utf8'); const persist = service.persist.bind(service);
    service.persist = async () => { throw new Error('ENOSPC'); };
    await assert.rejects(service.configureAccess({ hostId: id, mode: 'once', password: secret }), /previous access settings remain active/);
    assert.deepEqual((await service.getState()).hosts, before.hosts); assert.deepEqual(service.manualHosts, manual); assert.deepEqual(service.overrides, overrides);
    assert.equal(await fs.readFile(path.join(service.dataDir, 'state.json'), 'utf8'), stored); assert.equal(service.authenticationSetup, false);
    const pending = JSON.parse(await fs.readFile(auth.pendingFile(before.hosts[0]), 'utf8'));
    await fs.access(path.join(auth.dataDir, 'ssh-keys', pending.directory, 'id_ed25519'));
    service.persist = persist;
    state = await service.configureAccess({ hostId: id, mode: 'once', password: secret });
    assert.equal(state.hosts[0].status, 'ready'); assert.notEqual(state.hosts[0].identityFile, '~/.ssh/original-key');
    assert.equal(commands.filter(call => call.command === 'ssh-keygen' && call.args.includes('-t')).length, 1);
    await assert.rejects(fs.access(auth.pendingFile(before.hosts[0])), { code: 'ENOENT' });
  }
});
