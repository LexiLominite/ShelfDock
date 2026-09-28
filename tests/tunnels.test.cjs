'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { Server, utils } = require('ssh2');
const { PasswordAuth } = require('../desktop/password-auth.cjs');
const { TunnelManager, validateTunnel, verifyListener, listenerCommand } = require('../desktop/tunnels.cjs');
const execute = promisify(execFile);
const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const freePort = async () => { const server = net.createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };
async function echo(port, message) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }); const timer = setTimeout(() => { socket.destroy(); reject(new Error('Echo fixture timed out')); }, 3000);
    socket.on('error', error => { clearTimeout(timer); reject(error); }); socket.on('connect', () => socket.write(message));
    socket.once('data', data => { clearTimeout(timer); socket.destroy(); resolve(data.toString()); });
  });
}
async function closedPort(port) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const open = await new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); socket.once('error', () => resolve(false)); socket.once('connect', () => { socket.destroy(); resolve(true); }); });
    if (!open) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('Owned tunnel port remained open after stop');
}
async function fixture(t, { password = false, reportWildcard = false, website = false, targetName = '127.0.0.1', destinationPort } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dropharbor-tunnel-test-'));
  const keyPair = () => { for (let attempt = 0; attempt < 10; attempt++) { const value = utils.generateKeyPairSync('ed25519'); if (!(utils.parseKey(value.private) instanceof Error)) return value; } throw new Error('Could not generate a valid ephemeral fixture key.'); };
  const serverKey = keyPair(); const userKey = keyPair();
  const identity = path.join(directory, 'id_ed25519'); await fs.writeFile(identity, userKey.private, { mode: 0o600 });
  const authorized = utils.parseKey(userKey.public); const clients = new Set(); const sockets = new Set(); const remoteListeners = new Set();
  const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket; };
  const requestedTargets = []; const websiteRequests = [];
  const echoServer = website ? require('node:http').createServer((request, response) => { websiteRequests.push({ method: request.method, url: request.url }); response.writeHead(404); response.end(); }) : net.createServer(socket => { track(socket); socket.pipe(socket); }); const targetPort = await listen(echoServer);
  const ssh = new Server({ hostKeys: [serverKey.private] }, client => {
    clients.add(client); client.on('error', () => {});
    const owned = new Map();
    client.once('close', () => { clients.delete(client); for (const server of owned.values()) { server.close(); remoteListeners.delete(server); } });
    client.on('authentication', context => {
      if (context.username !== 'fixture') return context.reject();
      if (context.method === 'password') return context.password === 'fixture-password' ? context.accept() : context.reject();
      if (context.method !== 'publickey' || !context.key.data.equals(authorized.getPublicSSH())) return context.reject();
      if (context.signature && authorized.verify(context.blob, context.signature, context.hashAlgo) !== true) return context.reject();
      context.accept();
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        requestedTargets.push({ host: info.destIP, port: info.destPort });
        if (info.destIP !== targetName || info.destPort !== (destinationPort || targetPort)) return reject();
        const stream = accept(); const socket = track(net.connect({ host: '127.0.0.1', port: targetPort })); stream.on('error', () => socket.destroy()); stream.once('close', () => socket.destroy()); socket.pipe(stream); stream.pipe(socket);
      });
      client.on('request', (accept, reject, name, info) => {
        if (name === 'cancel-tcpip-forward') { owned.get(info.bindPort)?.close(); owned.delete(info.bindPort); return accept?.(); }
        if (name !== 'tcpip-forward' || info.bindAddr !== '127.0.0.1') return reject?.();
        const server = net.createServer(socket => {
          track(socket);
          client.forwardOut('127.0.0.1', info.bindPort, '127.0.0.1', socket.remotePort, (error, stream) => {
            if (error) return socket.destroy(); stream.on('error', () => socket.destroy()); stream.once('close', () => socket.destroy()); socket.pipe(stream); stream.pipe(socket);
          });
        });
        server.once('error', () => reject?.()); server.listen(info.bindPort, '127.0.0.1', () => { owned.set(info.bindPort, server); remoteListeners.add(server); accept(info.bindPort); });
      });
      client.on('session', accept => accept().on('exec', (acceptCommand, reject, info) => {
        const stream = acceptCommand();
        // Report the actual fixture listener; do not depend on ss/lsof being installed in CI.
        const port = [...remoteListeners].map(server => server.address()?.port).find(port => info.command.includes(String(port)));
        if (!port) { stream.exit(1); stream.end(); return; }
        stream.write(`DRIFT_BIND_SS\nLISTEN 0 128 ${reportWildcard ? '0.0.0.0' : '127.0.0.1'}:${port} 0.0.0.0:*\n`); stream.exit(0); stream.end();
      }));
    });
  });
  const sshPort = await listen(ssh); const known = path.join(directory, 'known_hosts'); await fs.writeFile(known, `[127.0.0.1]:${sshPort} ${serverKey.public}\n`);
  const host = { id: 'fixture-host', name: 'Loopback fixture', address: '127.0.0.1', user: 'fixture', port: sshPort, identityFile: identity, sshAlias: '', os: 'posix' };
  const calls = [];
  const run = async (command, args, options = {}) => {
    calls.push({ command, args });
    if (args.includes('-G')) return { stdout: `hostname 127.0.0.1\nuserknownhostsfile ${known}\nglobalknownhostsfile none\n`, stderr: '' };
    return execute(command, args, { timeout: 6000, ...options });
  };
  const auth = new PasswordAuth({ dataDir: path.join(directory, 'data'), homeDir: directory, platform: 'darwin', run, safeStorage: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(Buffer.from(value).toString('base64')), decryptString: value => Buffer.from(value.toString(), 'base64').toString() } });
  await auth.initialized; if (password) await auth.save(host, 'fixture-password');
  const service = { passwordAuth: auth, getState: async () => ({ hosts: [host] }), run, sshArgs: () => ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'UserKnownHostsFile=' + known, '-o', 'GlobalKnownHostsFile=/dev/null', '-p', String(sshPort), '-i', identity, 'fixture@127.0.0.1'] };
  const manager = new TunnelManager({ dataDir: path.join(directory, 'data'), service, startupTimeout: 7000 });
  t.after(async () => { await manager.shutdown(); for (const socket of sockets) socket.destroy(); for (const client of clients) client.end(); for (const listener of remoteListeners) listener.close(); await new Promise(resolve => ssh.close(resolve)); await new Promise(resolve => echoServer.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, service, host, directory, targetPort, calls, remoteListeners, requestedTargets, websiteRequests };
}

test('forwarding validates domains, ports, notes and mode without accepting shell-like input', () => {
  const valid = { mode: 'local', targetHost: 'example.invalid', targetPort: 443, listenPort: 8443, note: 'Development service', remember: true };
  assert.equal(validateTunnel(valid).targetPort, 443); assert.equal(validateTunnel({ ...valid, targetHost: '[::1]' }).targetHost, '::1');
  for (const patch of [{ targetHost: '-oProxyCommand=bad' }, { targetHost: 'http://example.invalid' }, { targetHost: 'host;command' }, { listenPort: 0 }, { targetPort: 65536 }, { mode: 'dynamic' }, { note: 'x'.repeat(501) }, { remember: 'yes' }, { autoListen: 'yes' }, { autoListen: true, mode: 'remote' }]) assert.throws(() => validateTunnel({ ...valid, ...patch }));
});

test('listener verification rejects wildcard, missing and unrecognized results', () => {
  verifyListener('DRIFT_BIND_SS\nLISTEN 0 128 127.0.0.1:8080 0.0.0.0:*\n', 8080);
  verifyListener('DRIFT_BIND_LSOF\np123\nfn1\nn127.0.0.1:8080\n', 8080);
  verifyListener('DRIFT_BIND_WINDOWS\n127.0.0.1\n::1\n', 8080);
  for (const stdout of ['', 'DRIFT_BIND_SS\nLISTEN 0 128 0.0.0.0:8080 0.0.0.0:*', 'DRIFT_BIND_WINDOWS\n::\n', 'DRIFT_BIND_LSOF\nn*:8080']) assert.throws(() => verifyListener(stdout, 8080), /loopback/);
  const windows = listenerCommand({ os: 'windows' }, 8080); assert.ok(Buffer.from(windows.split(' ').at(-1), 'base64').toString('utf16le').includes('Get-NetTCPConnection'));
});

test('native OpenSSH local forward owns a real PID, passes traffic, persists a credential-free plan, and releases the port', { timeout: 15000 }, async t => {
  const { manager, service, targetPort, directory } = await fixture(t); const listenPort = await freePort();
  const result = await manager.start({ hostId: 'fixture-host', mode: 'local', targetHost: '127.0.0.1', targetPort, listenPort, remember: true, note: 'Fixture service' });
  const active = result.active[0]; assert.equal(active.status, 'running', active.error); assert.ok(active.pid > 0); assert.equal(service.tunnelSetup, 0);
  assert.equal(await echo(listenPort, 'native traffic'), 'native traffic');
  const historyFile = path.join(directory, 'data', 'tunnels.json'); const saved = await fs.readFile(historyFile, 'utf8');
  assert.ok(!saved.includes('fixture-password')); assert.ok(!saved.includes('identityFile')); assert.ok(!saved.includes('PRIVATE KEY')); assert.equal((await fs.stat(historyFile)).mode & 0o777, 0o600);
  const fresh = new TunnelManager({ dataDir: path.join(directory, 'data'), service }); assert.equal((await fresh.getState()).active.length, 0); assert.equal((await fresh.getState()).history.length, 1); await fresh.shutdown();
  await manager.stop(active.id); await closedPort(listenPort); assert.throws(() => process.kill(active.pid, 0));
});

test('saved-password local and remote forwards pass traffic and stop without spawning SSH children', { timeout: 15000 }, async t => {
  for (const mode of ['local', 'remote']) {
    const { manager, targetPort, remoteListeners } = await fixture(t, { password: true }); const listenPort = await freePort();
    const result = await manager.start({ hostId: 'fixture-host', mode, targetHost: '127.0.0.1', targetPort, listenPort, remember: false });
    const active = result.active[0]; assert.equal(active.status, 'running', active.error); assert.equal(active.pid, undefined);
    assert.equal(await echo(listenPort, 'password ' + mode), 'password ' + mode);
    if (mode === 'remote') assert.equal([...remoteListeners][0].address().address, '127.0.0.1');
    await manager.stop(active.id); await closedPort(listenPort);
  }
});

test('unverified remote wildcard binding is refused and its listener is closed', { timeout: 15000 }, async t => {
  const { manager, targetPort } = await fixture(t, { password: true, reportWildcard: true }); const listenPort = await freePort();
  const result = await manager.start({ hostId: 'fixture-host', mode: 'remote', targetHost: '127.0.0.1', targetPort, listenPort });
  assert.equal(result.active[0].status, 'failed'); assert.match(result.active[0].error, /loopback/); await closedPort(listenPort);
});

test('remembered plans support note edits and explicit repeat, but cannot retarget after host edits', { timeout: 15000 }, async t => {
  const { manager, host, targetPort } = await fixture(t, { password: true }); const listenPort = await freePort();
  let state = await manager.start({ hostId: host.id, mode: 'local', targetHost: '127.0.0.1', targetPort, listenPort, remember: true, note: 'first' });
  const plan = state.history[0]; await manager.updateNote({ id: plan.id, note: 'updated note' }); assert.equal((await manager.getState()).active[0].note, 'updated note');
  await assert.rejects(manager.start({ hostId: host.id, mode: 'local', targetHost: '127.0.0.1', targetPort, listenPort }), /already using/);
  await manager.stop(state.active[0].id); state = await manager.restart(plan.id); assert.equal(state.active[0].status, 'running'); assert.equal(state.history.length, 1);
  await manager.stop(state.active[0].id); host.user = 'different-user';
  await assert.rejects(manager.restart(plan.id), /connection details changed/); assert.equal((await manager.getState()).active.length, 0);
  await manager.removeHistory(plan.id); assert.equal((await manager.getState()).history.length, 0);
});

test('native route refuses inherited forwarding rules before it can create another listener', async t => {
  const { manager, service, targetPort } = await fixture(t); const listenPort = await freePort();
  service.run = async () => ({ stdout: 'hostname 127.0.0.1\nlocalforward 0.0.0.0:9999 example.invalid:443\n', stderr: '' });
  const state = await manager.start({ hostId: 'fixture-host', mode: 'local', targetHost: '127.0.0.1', targetPort, listenPort });
  assert.equal(state.active[0].status, 'failed'); assert.match(state.active[0].error, /already defines forwarding/); assert.equal(state.active[0].pid, undefined); await closedPort(listenPort);
});

test('configuration and credential setup prevent forwarding start', async t => {
  const { manager, service, targetPort } = await fixture(t);
  for (const flag of ['authenticationSetup', 'configurationImport', 'configurationSaving']) {
    service[flag] = true;
    await assert.rejects(manager.start({ hostId: 'fixture-host', mode: 'local', targetHost: '127.0.0.1', targetPort, listenPort: 54321 }), /setup to finish/);
    service[flag] = false;
  }
});

test('native remote forward waits for success and verified loopback binding before passing traffic', { timeout: 15000 }, async t => {
  const { manager, targetPort } = await fixture(t); const listenPort = await freePort();
  const state = await manager.start({ hostId: 'fixture-host', mode: 'remote', targetHost: '127.0.0.1', targetPort, listenPort });
  const active = state.active[0]; assert.equal(active.status, 'running', active.error); assert.ok(active.pid > 0);
  assert.equal(await echo(listenPort, 'native reverse traffic'), 'native reverse traffic');
  await manager.stop(active.id); await closedPort(listenPort); assert.throws(() => process.kill(active.pid, 0));
});

test('authentication alone cannot mark native startup ready and timeout terminates its owned child', async t => {
  const { manager, service, targetPort } = await fixture(t); const { EventEmitter } = require('node:events'); const killed = [];
  manager.startupTimeout = 25;
  manager.spawnProcess = (command, args, options) => {
    assert.equal(command, 'ssh'); assert.equal(options.shell, false); assert.ok(args.includes('ForkAfterAuthentication=no')); assert.ok(args.includes('PermitLocalCommand=no')); assert.ok(args.includes('ControlPath=none'));
    const child = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 123456;
    child.kill = signal => { killed.push(signal); queueMicrotask(() => child.emit('exit', null, signal)); return true; };
    queueMicrotask(() => child.stderr.emit('data', Buffer.from('Authenticated to fixture using publickey.\n')));
    return child;
  };
  const state = await manager.start({ hostId: 'fixture-host', mode: 'local', targetHost: '127.0.0.1', targetPort, listenPort: await freePort() });
  assert.equal(state.active[0].status, 'failed'); assert.match(state.active[0].error, /did not become ready/); assert.deepEqual(killed, ['SIGTERM']); assert.equal(service.tunnelSetup, 0);
});

test('forwarding rechecks Mac installation lock after queued initialization and host-state reads', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dropharbor-tunnel-install-guard-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const host = { id: 'fixture', name: 'Fixture', address: 'example.invalid', user: 'fixture', port: 22 };
  let release; let blockedRead = false; let entered; const enteredRead = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const service = { getState: async () => { if (blockedRead) { entered(); await gate; } return { hosts: [host] }; }, run: () => assert.fail('No SSH command may start'), sshArgs: () => assert.fail('No SSH command may start') };
  const manager = new TunnelManager({ dataDir: directory, service }); await manager.initialized;
  const input = { hostId: host.id, mode: 'local', targetHost: 'localhost', targetPort: 8000, listenPort: 8001 };
  const first = manager.start(input); service.macInstallation = true; await assert.rejects(first, /Mac installation/); assert.equal((await manager.getState()).active.length, 0);
  service.macInstallation = false; blockedRead = true; const second = manager.start(input); await enteredRead; service.macInstallation = true; release(); await assert.rejects(second, /Mac installation/); assert.equal((await manager.getState()).active.length, 0); await manager.shutdown();
});

test('automatic local forwarding skips occupied ports and verifies HTTP through the remote machine’s private destination', { timeout: 15000 }, async t => {
  const { verifyTunnelSite, tunnelSiteURL } = require('../desktop/tunnel-site.cjs');
  const { manager, targetPort, requestedTargets, websiteRequests } = await fixture(t, { website: true, targetName: '192.168.1.2' });
  // The fixture's web server deliberately occupies the preferred local port.
  const state = await manager.start({ hostId: 'fixture-host', mode: 'local', targetHost: '192.168.1.2', targetPort, listenPort: targetPort, autoListen: true, remember: true });
  const active = state.active[0]; assert.equal(active.status, 'running', active.error); assert.notEqual(active.listenPort, targetPort); assert.equal(active.autoListen, true);
  const url = tunnelSiteURL({ id: active.id, scheme: 'http:', path: '/private/app?token=transient#section' }, state);
  assert.equal(url, `http://127.0.0.1:${active.listenPort}/private/app?token=transient#section`);
  await verifyTunnelSite(url, manager.active.get(active.id));
  assert.deepEqual(requestedTargets, [{ host: '192.168.1.2', port: targetPort }]); assert.deepEqual(websiteRequests, [{ method: 'HEAD', url: '/private/app?token=transient' }]);
  assert.equal(state.history[0].listenPort, active.listenPort); assert.equal(state.history[0].autoListen, true);
  await manager.stop(active.id); await closedPort(active.listenPort);
});

test('automatic saved-password forward maps remote port 80 to an unprivileged loopback listener', { timeout: 15000 }, async t => {
  const { verifyTunnelSite, tunnelSiteURL } = require('../desktop/tunnel-site.cjs');
  const { manager, requestedTargets } = await fixture(t, { password: true, website: true, targetName: 'localhost', destinationPort: 80 });
  const state = await manager.start({ hostId: 'fixture-host', mode: 'local', targetHost: 'localhost', targetPort: 80, listenPort: 80, autoListen: true, remember: true });
  const active = state.active[0]; assert.equal(active.status, 'running', active.error); assert.ok(active.listenPort >= 1024); assert.equal(active.targetPort, 80);
  await verifyTunnelSite(tunnelSiteURL({ id: active.id, scheme: 'http:', path: '/' }, state), manager.active.get(active.id));
  assert.deepEqual(requestedTargets, [{ host: 'localhost', port: 80 }]);
});

test('automatic port selection tries successive ports, while explicit custom ports fail without silently changing', { timeout: 15000 }, async t => {
  const { manager, targetPort } = await fixture(t);
  const state = await manager.start({ hostId: 'fixture-host', mode: 'local', targetHost: '127.0.0.1', targetPort, listenPort: targetPort });
  assert.equal(state.active[0].status, 'failed'); assert.equal(state.active[0].listenPort, targetPort); assert.match(state.active[0].error, /listening port is unavailable/);
  const { EventEmitter } = require('node:events'); const attempts = [];
  manager.network = { createServer: () => { const server = new EventEmitter(); server.listen = (port, host, callback) => { attempts.push([port, host]); queueMicrotask(() => port < 8002 ? server.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' })) : callback()); }; server.address = () => ({ port: 8002 }); server.close = callback => callback(); return server; } };
  const record = { view: { listenPort: 9000, targetPort: 8000 }, stopped: false };
  assert.equal(await manager.availableLocalPort(record), 8002); assert.deepEqual(attempts, [[8000, '127.0.0.1'], [8001, '127.0.0.1'], [8002, '127.0.0.1']]);
});

test('a reachable SSH listener does not pass website readiness when the remote service is unavailable', { timeout: 15000 }, async t => {
  const { verifyTunnelSite, tunnelSiteURL } = require('../desktop/tunnel-site.cjs');
  const { manager, targetPort } = await fixture(t);
  const unusedPort = await freePort();
  const state = await manager.start({ hostId: 'fixture-host', mode: 'local', targetHost: '127.0.0.1', targetPort: unusedPort, listenPort: targetPort, autoListen: true });
  const active = state.active[0]; assert.equal(active.status, 'running', active.error);
  await assert.rejects(verifyTunnelSite(tunnelSiteURL({ id: active.id, scheme: 'http:', path: '/' }, state), manager.active.get(active.id)), /could not be reached.*Loopback fixture/);
});
