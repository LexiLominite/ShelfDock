'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const MAX_MESSAGE_BYTES = 128;
const ACK = 'LEX_DRIFT_WORKER/1 OK\n';
const SOCKET_TIMEOUT_MS = 1500;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function workerEndpoint(runtimeDir, platform = process.platform) {
  if (typeof runtimeDir !== 'string' || !path.isAbsolute(runtimeDir)) throw new Error('The shared worker needs an absolute runtime directory.');
  const directory = path.resolve(runtimeDir);
  if (platform === 'win32') {
    const identity = directory.replaceAll('\\', '/').toLowerCase();
    const hash = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
    return `\\\\.\\pipe\\lex-drift-${hash}`;
  }
  const endpoint = path.join(directory, 'worker.sock');
  if (Buffer.byteLength(endpoint, 'utf8') > (platform === 'darwin' ? 103 : 107)) throw new Error('The shared worker runtime directory is too long. Use a shorter private directory.');
  return endpoint;
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The shared worker runtime path must be a private directory, not a link or file.');
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('The shared worker runtime directory belongs to another user.');
    await fs.chmod(directory, 0o700);
  }
}

function liveWorker(endpoint, background) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(endpoint);
    let response = Buffer.alloc(0); let settled = false;
    const finish = error => {
      if (settled) return; settled = true;
      client.destroy();
      if (error) reject(error); else resolve();
    };
    client.setTimeout(SOCKET_TIMEOUT_MS, () => finish(new Error('An existing ShelfDock or LexBridge worker did not respond. Quit that worker before starting another.')));
    client.once('connect', () => client.write(background ? 'PING\n' : 'SHOW\n'));
    client.on('data', chunk => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_MESSAGE_BYTES) { finish(new Error('The shared worker returned an invalid response.')); return; }
      if (response.includes(10)) {
        if (response.toString('utf8') === ACK) finish();
        else finish(new Error('Another program is using the shared app worker endpoint.'));
      }
    });
    client.once('error', finish);
    client.once('end', () => { if (!settled) finish(new Error('The shared worker closed without acknowledging this launch.')); });
  });
}

function newServer(onShow) {
  const clients = new Set();
  const server = net.createServer(client => {
    clients.add(client); client.once('close', () => clients.delete(client));
    let message = Buffer.alloc(0); let handled = false;
    client.setTimeout(SOCKET_TIMEOUT_MS, () => client.destroy());
    client.on('error', () => {});
    client.on('data', chunk => {
      if (handled) { client.destroy(); return; }
      message = Buffer.concat([message, chunk]);
      if (message.length > MAX_MESSAGE_BYTES) { client.destroy(); return; }
      if (!message.includes(10)) return;
      handled = true;
      const command = message.toString('utf8');
      if (command !== 'SHOW\n' && command !== 'PING\n') { client.destroy(); return; }
      if (command === 'SHOW\n') {
        try { Promise.resolve(onShow()).catch(() => {}); } catch {}
      }
      client.end(ACK);
    });
  });
  // All startup errors are handled by listen(); later server errors must not
  // crash a running worker or release its endpoint to a second instance.
  server.on('error', () => {});
  return { server, clients };
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError); server.once('listening', onListening);
    try { server.listen(endpoint); } catch (error) { server.removeListener('error', onError); server.removeListener('listening', onListening); reject(error); }
  });
}

function ownSocket(stat) {
  return stat?.isSocket() && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}

async function socketStat(endpoint) {
  try { return await fs.lstat(endpoint); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function acquireWorker({ runtimeDir, onShow = () => {}, background = false } = {}) {
  const endpoint = workerEndpoint(runtimeDir);
  if (typeof onShow !== 'function' || typeof background !== 'boolean') throw new Error('Invalid shared worker launch options.');
  await privateDirectory(path.resolve(runtimeDir));
  for (let attempt = 0; attempt < 16; attempt++) {
    const { server, clients } = newServer(onShow);
    try {
      await listen(server, endpoint);
      if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600);
      let closed = false;
      return {
        primary: true,
        async close() {
          if (closed) return; closed = true;
          for (const client of clients) client.destroy();
          await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
      };
    } catch (error) {
      // If bind succeeded but setting private permissions failed, release it.
      if (server.listening) await new Promise(resolve => server.close(() => resolve()));
      if (error.code !== 'EADDRINUSE') throw error;
      const before = process.platform === 'win32' ? null : await socketStat(endpoint);
      if (before && !ownSocket(before)) throw new Error('The shared app worker endpoint is not an owned socket; it was left untouched.');
      try {
        await liveWorker(endpoint, background);
        return { primary: false, async close() {} };
      } catch (connectionError) {
        if (process.platform === 'win32') {
          // Windows removes named pipes when their owner exits. A lost race can
          // be retried, but a live/unresponsive listener must remain exclusive.
          if (!['ENOENT', 'ECONNREFUSED'].includes(connectionError.code)) throw connectionError;
        } else {
          if (connectionError.code === 'ENOENT') { await delay(15); continue; }
          if (connectionError.code !== 'ECONNREFUSED') throw connectionError;
          const current = await socketStat(endpoint);
          if (!current) { await delay(15); continue; }
          if (!ownSocket(before) || !ownSocket(current)) throw new Error('The shared app worker endpoint is not an owned socket; it was left untouched.');
          if (before.dev !== current.dev || before.ino !== current.ino) { await delay(15); continue; }
          // A successful connection is the only permission to reuse a worker;
          // refused connections plus a stable, owned socket identify a crash.
          try { await fs.unlink(endpoint); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
        }
        await delay(15);
      }
    }
  }
  throw new Error('The shared app worker is busy starting. Try launching it again.');
}

module.exports = { acquireWorker, workerEndpoint, MAX_MESSAGE_BYTES };
