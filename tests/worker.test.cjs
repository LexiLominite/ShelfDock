'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { acquireWorker, workerEndpoint, MAX_MESSAGE_BYTES } = require('../desktop/worker.cjs');

async function fixture(t) {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lex-drift-worker-'));
  const workers = [];
  t.after(async () => { for (const worker of workers) await worker.close(); await fs.rm(runtimeDir, { recursive: true, force: true }); });
  return { runtimeDir, workers, async acquire(options = {}) { const worker = await acquireWorker({ runtimeDir, ...options }); workers.push(worker); return worker; } };
}

async function send(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint); let response = '';
    socket.setTimeout(2500, () => { socket.destroy(); reject(new Error('Test socket timed out')); });
    socket.once('connect', () => socket.write(payload));
    socket.on('data', chunk => { response += chunk.toString('utf8'); });
    socket.once('error', error => { if (error.code === 'ECONNRESET' || error.code === 'EPIPE') resolve(response); else reject(error); });
    socket.once('close', () => resolve(response));
  });
}

test('different application profiles share one worker and foreground launches only request its existing shelf', async t => {
  const setup = await fixture(t); let shows = 0; let secondaryShows = 0;
  const primary = await setup.acquire({ onShow: () => { shows++; } });
  assert.equal(primary.primary, true);
  // The common runtimeDir deliberately contains no userData/profile name.
  const cleanEdition = await setup.acquire({ onShow: () => { secondaryShows++; } });
  const personalEdition = await setup.acquire({ onShow: () => { secondaryShows++; } });
  assert.equal(cleanEdition.primary, false);
  assert.equal(personalEdition.primary, false);
  assert.equal(shows, 2);
  assert.equal(secondaryShows, 0);
  await cleanEdition.close();
  assert.equal((await setup.acquire({ background: true })).primary, false);
  assert.equal(shows, 2);
});

test('background/login launches acknowledge the primary worker without revealing a window', async t => {
  const setup = await fixture(t); let shows = 0;
  const primary = await setup.acquire({ background: true, onShow: () => { shows++; } });
  const secondary = await setup.acquire({ background: true });
  assert.equal(primary.primary, true);
  assert.equal(secondary.primary, false);
  assert.equal(shows, 0);
  await setup.acquire();
  assert.equal(shows, 1);
});

test('simultaneous application launches elect one primary worker', async t => {
  const setup = await fixture(t); let shows = 0;
  const workers = await Promise.all(Array.from({ length: 20 }, () => setup.acquire({ onShow: () => { shows++; } })));
  assert.equal(workers.filter(worker => worker.primary).length, 1);
  assert.equal(shows, 19);
});

test('private socket permissions and clean shutdown permit a new primary worker', { skip: process.platform === 'win32' }, async t => {
  const setup = await fixture(t);
  const primary = await setup.acquire();
  assert.equal((await fs.stat(setup.runtimeDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(workerEndpoint(setup.runtimeDir))).mode & 0o777, 0o600);
  await primary.close(); await primary.close();
  const next = await setup.acquire();
  assert.equal(next.primary, true);
});

test('worker ignores unsupported, compound, oversized, and nonterminated messages', async t => {
  const setup = await fixture(t); let shows = 0;
  await setup.acquire({ onShow: () => { shows++; } });
  const endpoint = workerEndpoint(setup.runtimeDir);
  for (const payload of ['QUIT\n', 'SHOW\nPING\n', 'show\n', 'SHOW\0\n', 'S'.repeat(MAX_MESSAGE_BYTES + 1), 'SHOW']) {
    assert.equal(await send(endpoint, payload), '');
  }
  assert.equal(shows, 0);
  assert.equal(await send(endpoint, 'PING\n'), 'LEX_DRIFT_WORKER/1 OK\n');
  assert.equal(shows, 0);
  assert.equal(await send(endpoint, 'SHOW\n'), 'LEX_DRIFT_WORKER/1 OK\n');
  assert.equal(shows, 1);
});

test('stale sockets from a crashed process are recovered without GUI processes', { skip: process.platform === 'win32' }, async t => {
  const setup = await fixture(t); const endpoint = workerEndpoint(setup.runtimeDir);
  const child = spawn(process.execPath, ['-e', 'const net=require("node:net");net.createServer().listen(process.argv[1],()=>process.stdout.write("READY\\n"));', endpoint], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => chunk.toString().includes('READY') ? resolve() : reject(new Error('Unexpected child output')));
    child.once('error', reject); child.once('exit', () => reject(new Error('Socket fixture exited before listening')));
  });
  const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await ended;
  assert.equal((await fs.lstat(endpoint)).isSocket(), true);
  const workers = await Promise.all(Array.from({ length: 12 }, () => setup.acquire({ background: true })));
  assert.equal(workers.filter(worker => worker.primary).length, 1);
});

test('an existing ordinary file at the socket path is never removed or replaced', { skip: process.platform === 'win32' }, async t => {
  const setup = await fixture(t); const endpoint = workerEndpoint(setup.runtimeDir);
  await fs.writeFile(endpoint, 'keep this file', { mode: 0o600 });
  await assert.rejects(setup.acquire(), /not an owned socket|using the lex-drift worker/);
  assert.equal(await fs.readFile(endpoint, 'utf8'), 'keep this file');
});

test('a symlink runtime directory is rejected rather than changing its target permissions', { skip: process.platform === 'win32' }, async t => {
  const setup = await fixture(t); const target = path.join(setup.runtimeDir, 'target'); const linked = path.join(setup.runtimeDir, 'linked');
  await fs.mkdir(target, { mode: 0o755 }); await fs.symlink(target, linked);
  await assert.rejects(acquireWorker({ runtimeDir: linked }), /not a link or file/);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
});

test('an unresponsive live listener is left intact and cannot create a second worker', async t => {
  const setup = await fixture(t); const endpoint = workerEndpoint(setup.runtimeDir); const clients = new Set();
  const server = net.createServer(client => { clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client)); });
  t.after(async () => { for (const client of clients) client.destroy(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
  await assert.rejects(setup.acquire({ background: true }), /did not respond/);
  assert.equal(server.listening, true);
  if (process.platform !== 'win32') assert.equal((await fs.lstat(endpoint)).isSocket(), true);
});

test('Windows named pipe identity is stable for a shared runtime directory and contains no profile data', () => {
  const runtimeDir = path.resolve(os.tmpdir(), 'lex-drift-shared');
  const pipe = workerEndpoint(runtimeDir, 'win32');
  assert.match(pipe, /^\\\\\.\\pipe\\lex-drift-[a-f0-9]{24}$/);
  assert.equal(pipe, workerEndpoint(runtimeDir.toUpperCase(), 'win32'));
  assert.equal(pipe.includes('lex-drift-shared'), false);
  assert.throws(() => workerEndpoint('relative'), /absolute/);
});
