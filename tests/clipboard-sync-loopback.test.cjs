'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Server, utils } = require('ssh2');
const { ClipboardSync } = require('../desktop/clipboard-sync.cjs');
const { connectSsh } = require('../desktop/clipboard-sync-ssh.cjs');

const PORT = 47635;
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';

const storage = () => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: value => Buffer.from(`fixture:${value}`),
  decryptString: value => {
    const text = Buffer.isBuffer(value) ? value.toString() : String(value);
    if (!text.startsWith('fixture:')) throw new Error('fixture secret is unavailable');
    return text.slice('fixture:'.length);
  },
});

const waitFor = (predicate, message, timeoutMs = 7000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + timeoutMs;
  const check = () => {
    if (predicate()) { resolve(); return; }
    if (Date.now() >= deadline) { reject(new Error(message)); return; }
    setTimeout(check, 15);
  };
  check();
});

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

test('clipboard sync pairs and exchanges text and PNG both ways over an owned real OpenSSH tunnel', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shelfdock-sync-ssh-'));
  const clientHome = path.join(directory, 'isolated-home');
  await fs.mkdir(clientHome, { recursive: true, mode: 0o700 });
  const hostKey = utils.generateKeyPairSync('ed25519');
  const userKey = utils.generateKeyPairSync('ed25519');
  const identityFile = path.join(directory, 'fixture-client-key');
  await fs.writeFile(identityFile, userKey.private, { mode: 0o600 });

  const clients = new Set();
  const channels = new Set();
  const forwardedSockets = new Set();
  const children = new Set();
  const received = { sender: [], receiver: [] };
  const listener = new Server({ hostKeys: [hostKey.private] }, client => {
    clients.add(client);
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.username !== 'fixture-user' || context.method !== 'publickey' || !context.key.data.equals(utils.parseKey(userKey.public).getPublicSSH())) return context.reject();
      const parsed = utils.parseKey(userKey.public);
      if (context.signature && parsed.verify(context.blob, context.signature, context.hashAlgo) !== true) return context.reject();
      context.accept();
    });
    client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1' || Number(info.destPort) !== PORT || !receiver?.port) return reject();
      const channel = accept();
      const destination = net.connect({ host: '127.0.0.1', port: receiver.port });
      channels.add(channel);
      forwardedSockets.add(destination);
      channel.on('error', () => destination.destroy());
      channel.once('close', () => { channels.delete(channel); destination.destroy(); });
      destination.on('error', () => channel.destroy());
      destination.once('close', () => forwardedSockets.delete(destination));
      channel.pipe(destination);
      destination.pipe(channel);
    }));
  });
  const sshPort = await listen(listener);
  const knownHosts = path.join(directory, 'known_hosts');
  await fs.writeFile(knownHosts, `[127.0.0.1]:${sshPort} ${hostKey.public}\n`, { mode: 0o600 });

  let sender;
  let receiver;
  const cleanup = async () => {
    await Promise.allSettled([sender?.shutdown(), receiver?.shutdown()]);
    for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
    const closeDeadline = Date.now() + 2000;
    while (children.size && Date.now() < closeDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
    const killDeadline = Date.now() + 1000;
    while (children.size && Date.now() < killDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (children.size) throw new Error('An owned OpenSSH test process did not stop after SIGKILL.');
    for (const channel of channels) channel.destroy();
    for (const socket of forwardedSockets) socket.destroy();
    for (const client of clients) client.destroy();
    await new Promise(resolve => listener.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  };
  t.after(cleanup);

  const trustPinnedSpawn = (command, args, options) => {
    const child = spawn(command, [
      '-F', '/dev/null',
      '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'IdentityAgent=none',
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      ...args,
    ], { ...options, env: { ...process.env, HOME: clientHome } });
    children.add(child);
    child.once('close', () => children.delete(child));
    return child;
  };

  sender = new ClipboardSync({
    dataDir: path.join(directory, 'sender-data'), safeStorage: storage(), platform: process.platform, port: 0,
    connect: peer => connectSsh(peer.sshTarget, trustPinnedSpawn),
    onItem: item => received.sender.push(item),
  });
  receiver = new ClipboardSync({
    dataDir: path.join(directory, 'receiver-data'), safeStorage: storage(), platform: process.platform, port: 0,
    onItem: item => received.receiver.push(item),
  });
  await Promise.all([sender.ready, receiver.ready]);
  await Promise.all([sender.setEnabled(true), receiver.setEnabled(true)]);
  const pairing = await receiver.beginPairing();
  await sender.pairWith({
    hostLabel: 'Loopback receiver', localLabel: 'Loopback sender', code: pairing.code, direction: 'both',
    sshTarget: { user: 'fixture-user', host: '127.0.0.1', port: sshPort, identityFile },
  });

  const sendAndWait = async (from, to, item) => {
    const before = to.length;
    await from.submitLocal({ eventId: crypto.randomUUID(), createdAt: Date.now(), ...item });
    await waitFor(() => to.length === before + 1, `timed out waiting for ${item.kind} over OpenSSH`);
    return to.at(-1);
  };

  const receiverText = await sendAndWait(sender, received.receiver, { kind: 'text', text: 'fixture sender text' });
  assert.equal(receiverText.text, 'fixture sender text');
  const receiverPng = await sendAndWait(sender, received.receiver, { kind: 'png', png: PNG_BASE64 });
  assert.equal(receiverPng.kind, 'png');
  assert.equal(receiverPng.png, PNG_BASE64);
  const senderText = await sendAndWait(receiver, received.sender, { kind: 'text', text: 'fixture receiver text' });
  assert.equal(senderText.text, 'fixture receiver text');
  const senderPng = await sendAndWait(receiver, received.sender, { kind: 'png', png: PNG_BASE64 });
  assert.equal(senderPng.kind, 'png');
  assert.equal(senderPng.png, PNG_BASE64);

  assert.ok(children.size > 0, 'the authenticated OpenSSH client remains owned while the sync socket is live');
  const senderPeerId = sender.peers[0].id;
  await sender.revoke(senderPeerId);
  await waitFor(() => receiver.peers.length === 0, 'remote revocation did not close the paired tunnel');
  await Promise.all([sender.setEnabled(false), receiver.setEnabled(false)]);
  await waitFor(() => children.size === 0, 'owned OpenSSH process did not exit after disable', 3000);
  assert.equal(sender.peers.length, 0);
  assert.equal(receiver.peers.length, 0);
});
