'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Server, utils } = require('ssh2');
const { PasswordAuth } = require('../desktop/password-auth.cjs');
const execute = promisify(execFile);

test('loopback SSH verifies hashed trust, password login, public-key installation, and actual key-only OpenSSH login', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dropharbor-loopback-test-'));
  let cleanupResources = async () => {};
  t.after(async () => { try { await cleanupResources(); } finally { await fs.rm(directory, { recursive: true, force: true }); } });
  const remoteHome = path.join(directory, 'receiver'); await fs.mkdir(path.join(remoteHome, '.ssh'), { recursive: true, mode: 0o700 });
  const authorized = path.join(remoteHome, '.ssh', 'authorized_keys'); const existing = '# unrelated existing authorized-key entry\n';
  await fs.writeFile(authorized, existing, { mode: 0o600 });
  // Generate genuine OpenSSH keys once; ssh2's generator can truncate leading
  // zero bytes in Ed25519 public keys and create malformed fixtures.
  const makeKey = async name => {
    const file = path.join(directory, name);
    await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'loopback-fixture', '-f', file], { timeout: 5000 });
    const privateKey = await fs.readFile(file, 'utf8');
    const publicKey = (await fs.readFile(file + '.pub', 'utf8')).trim();
    assert.equal(utils.parseKey(privateKey) instanceof Error, false, 'ssh2 must accept a genuine OpenSSH Ed25519 private key');
    assert.equal(utils.parseKey(publicKey) instanceof Error, false, 'ssh2 must accept a genuine OpenSSH Ed25519 public key');
    return { private: privateKey, public: publicKey, file };
  };
  const serverKey = await makeKey('fixture-host-key'); const clients = new Set(); const authentications = [];
  const server = new Server({ hostKeys: [serverKey.private] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      authentications.push(context.method);
      if (context.username !== 'fixture-user') return context.reject();
      if (context.method === 'password') return context.password === 'fixture-only-password' ? context.accept() : context.reject();
      if (context.method !== 'publickey') return context.reject();
      fs.readFile(authorized, 'utf8').then(content => {
        const encoded = context.key.data.toString('base64');
        if (!content.split('\n').some(line => line.split(' ')[1] === encoded)) return context.reject();
        const key = utils.parseKey(context.key.algo + ' ' + encoded);
        if (context.signature && key.verify(context.blob, context.signature, context.hashAlgo) !== true) return context.reject();
        context.accept();
      }).catch(() => context.reject());
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptCommand, reject, info) => {
        const stream = acceptCommand();
        execute('/bin/sh', ['-c', info.command], { env: { ...process.env, HOME: remoteHome }, timeout: 4000 }).then(result => {
          stream.write(result.stdout); stream.stderr.write(result.stderr); stream.exit(0); stream.end();
        }).catch(error => { stream.stderr.write(String(error.stderr || 'Fixture command failed')); stream.exit(1); stream.end(); });
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanupResources = async () => { for (const client of clients) client.destroy(); await new Promise(resolve => server.close(resolve)); };
  const port = server.address().port; const known = path.join(directory, 'known_hosts');
  await fs.writeFile(known, `[127.0.0.1]:${port} ${serverKey.public}\n`);
  await execute('ssh-keygen', ['-H', '-f', known]);
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push({ command, args });
    if (command === 'ssh' && args.includes('-G')) return { stdout: `hostname 127.0.0.1\nuserknownhostsfile ${known}\nglobalknownhostsfile none\n`, stderr: '' };
    return execute(command, args, { timeout: 5000, ...options });
  };
  const host = { address: '127.0.0.1', port, user: 'fixture-user', sshAlias: '', os: 'posix' };
  const auth = new PasswordAuth({ dataDir: path.join(directory, 'sender'), homeDir: directory, run });
  const key = await auth.bootstrap(host, 'fixture-only-password', async identity => {
    const result = await execute('ssh', ['-F', '/dev/null', '-p', String(port), '-i', identity, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes', '-o', 'PreferredAuthentications=publickey', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + known, '-o', 'GlobalKnownHostsFile=/dev/null', 'fixture-user@127.0.0.1', 'echo DRIFT_READY'], { timeout: 5000 });
    assert.ok(result.stdout.includes('DRIFT_READY'));
  });
  const receiver = await fs.readFile(authorized, 'utf8'); const generated = (await fs.readFile(key + '.pub', 'utf8')).trim();
  assert.ok(receiver.startsWith(existing)); assert.ok(receiver.includes(generated)); assert.ok(!receiver.includes('PRIVATE KEY'));
  assert.equal((await fs.stat(key)).mode & 0o777, 0o600); assert.ok(authentications.includes('password')); assert.ok(authentications.filter(method => method === 'publickey').length >= 2);
  assert.ok(!JSON.stringify(calls).includes('fixture-only-password')); assert.equal(auth.metadata(host).hasSavedPassword, false);
});
