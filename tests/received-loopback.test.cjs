'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile, spawn } = require('node:child_process');
const { Server, utils } = require('ssh2');
const { DriftService } = require('../desktop/service.cjs');
const { ReceivedManager, RECEIPT_NAME } = require('../desktop/received.cjs');
const execute = promisify(execFile);

test('actual OpenSSH/SCP over loopback delivers a file and folder into another app inbox with strict host trust', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dropharbor-receive-ssh-'));
  const remoteHome = path.join(directory, 'receiver'); const desktopDir = path.join(remoteHome, 'Desktop'); await fs.mkdir(desktopDir, { recursive: true });
  const serverKey = utils.generateKeyPairSync('ed25519'); const clientKey = utils.generateKeyPairSync('ed25519');
  const keyFile = path.join(directory, 'fixture_key'); await fs.writeFile(keyFile, clientKey.private, { mode: 0o600 });
  const clients = new Set(); const processes = new Set();
  const server = new Server({ hostKeys: [serverKey.private] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.username !== 'fixture' || context.method !== 'publickey' || context.key.data.toString('base64') !== clientKey.public.split(' ')[1]) return context.reject();
      const parsed = utils.parseKey(clientKey.public);
      if (context.signature && parsed.verify(context.blob, context.signature, context.hashAlgo) !== true) return context.reject();
      context.accept();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptCommand, reject, info) => {
        const stream = acceptCommand();
        const child = spawn('/bin/sh', ['-c', info.command], { env: { ...process.env, HOME: remoteHome }, cwd: remoteHome, stdio: ['pipe', 'pipe', 'pipe'] });
        processes.add(child); stream.pipe(child.stdin); child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr, { end: false });
        child.stdin.on('error', () => {}); stream.on('error', () => {});
        child.once('error', () => { stream.exit(1); stream.end(); });
        child.once('close', code => { processes.delete(child); stream.exit(code || 0); stream.end(); });
        stream.once('close', () => { if (processes.has(child)) child.kill(); });
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const child of processes) child.kill(); for (const client of clients) client.destroy(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const port = server.address().port; const known = path.join(directory, 'known_hosts'); await fs.writeFile(known, `[127.0.0.1]:${port} ${serverKey.public}\n`);
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push({ command, args });
    return execute(command, ['-F', '/dev/null', '-o', 'UserKnownHostsFile=' + known, '-o', 'GlobalKnownHostsFile=/dev/null', ...args], { ...options, timeout: 7000 });
  };
  const sender = new DriftService({ dataDir: path.join(directory, 'sender-data'), homeDir: path.join(directory, 'sender-home'), execFile: run, platform: 'linux' });
  const receiver = new ReceivedManager({ dataDir: path.join(directory, 'receiver-data'), desktopDir });
  await sender.saveHost({ name: 'Receiving laptop', address: '127.0.0.1', user: 'fixture', port, identityFile: keyFile });
  sender.state.environment.sshAvailable = true; await sender.probeHosts(); const host = sender.state.hosts[0]; assert.equal(host.status, 'ready');
  await sender.updateSettings({ deviceName: 'Test laptop' });
  const file = path.join(directory, "quarter's notes.txt"); await fs.writeFile(file, 'Delivered through encrypted SSH');
  const folder = path.join(directory, 'Images'); await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'sample.txt'), 'folder payload');
  const queue = await sender.enqueueFiles([file, folder]); const result = await sender.send({ hostId: host.id, itemIds: queue.enqueuedItemIds });
  assert.equal(result.history[0].status, 'sent', result.history[0].message); assert.equal(result.history[0].receiptPublished, true);
  const inbox = await receiver.refresh(); assert.equal(inbox.received.length, 1); assert.equal(inbox.unreadCount, 1); assert.equal(inbox.received[0].senderLabel, 'Test laptop');
  assert.deepEqual(inbox.received[0].items.map(item => item.name), ["quarter's notes.txt", 'Images']);
  assert.equal(await fs.readFile(path.join(result.history[0].destination, "quarter's notes.txt"), 'utf8'), 'Delivered through encrypted SSH');
  assert.equal(await fs.readFile(path.join(result.history[0].destination, 'Images', 'sample.txt'), 'utf8'), 'folder payload');
  assert.ok((await fs.stat(path.join(result.history[0].destination, RECEIPT_NAME))).isFile());
  assert.equal(calls.filter(call => call.command === 'scp').length, 3);
  for (const call of calls) assert.ok(call.args.includes('StrictHostKeyChecking=yes'));
});
