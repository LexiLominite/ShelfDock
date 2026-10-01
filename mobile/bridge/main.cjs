#!/usr/bin/env node
'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pipeline } = require('node:stream/promises');
const { createBridge, init, readPrivate, validEndpoint, validName, DEFAULT_RUNTIME, DEFAULT_PORT } = require('./server.cjs');

function argumentsFor(argv) {
  const args = [], options = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith('--')) args.push(value);
    else if (value === '--show') options.show = true;
    else if (['--runtime', '--endpoint', '--device', '--port', '--desktop'].includes(value)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${value}.`);
      options[value.slice(2)] = argv[++i];
    } else throw new Error('Unknown option.');
  }
  return { args, options };
}
async function lock(runtime) {
  const lockDir = path.join(runtime, 'instance.lock');
  try { await fs.mkdir(lockDir, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let pid; try { pid = Number(await fs.readFile(path.join(lockDir, 'pid'), 'utf8')); } catch { throw new Error('Bridge lock exists. Inspect it before recovery.'); }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Bridge lock exists. Inspect it before recovery.');
    try { process.kill(pid, 0); throw new Error('Bridge is already running.'); }
    catch (check) { if (check.code !== 'ESRCH') throw check; }
    await fs.rm(lockDir, { recursive: true }); await fs.mkdir(lockDir, { mode: 0o700 });
  }
  await fs.writeFile(path.join(lockDir, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => fs.rm(lockDir, { recursive: true, force: true });
}
function request(config, route, { method = 'GET', body, stream, headers = {} } = {}) {
  // Owner secrets are restricted to loopback, including when pairing advertises a tailnet IP.
  const endpoint = new URL(config.endpoint); const target = `http://127.0.0.1:${endpoint.port || (endpoint.protocol === 'https:' ? 443 : DEFAULT_PORT)}`;
  return new Promise((resolve, reject) => {
    const req = http.request(target + route, { method, headers: { Authorization: `Bearer ${config.ownerToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = []; let total = 0;
      res.on('data', chunk => { total += chunk.length; if (total > 8 * 1024 * 1024) { res.destroy(); reject(new Error('Bridge response too large.')); } else chunks.push(chunk); });
      res.on('end', () => { let result; try { result = JSON.parse(Buffer.concat(chunks)); } catch { return reject(new Error('Invalid bridge response.')); } if (res.statusCode >= 400) { const e = new Error(result.error || 'Bridge request failed.'); e.status = res.statusCode; return reject(e); } resolve(result); });
      res.on('error', reject);
    });
    req.setTimeout(600000, () => req.destroy(new Error('Bridge request timed out.')));
    req.on('error', reject);
    if (stream) pipeline(stream, req).catch(reject);
    else req.end(body ? JSON.stringify(body) : undefined);
  });
}
async function main(argv = process.argv.slice(2)) {
  const { args, options } = argumentsFor(argv); const command = args[0]; const runtime = path.resolve(options.runtime || DEFAULT_RUNTIME);
  if (!['init', 'serve', 'pair', 'status', 'send', 'revoke'].includes(command)) throw new Error('Usage: main.cjs init|serve|pair|status|send <path> --device UUID|revoke UUID [--runtime dir] [--endpoint privateURL]');
  if (command === 'init') {
    await init(runtime, options.endpoint); console.log(JSON.stringify({ runtime, agentConfig: path.join(runtime, 'agent.json'), protocolVersion: 1 })); return;
  }
  const config = await readPrivate(path.join(runtime, 'config.json'));
  if (command === 'serve') {
    const port = Number(options.port || new URL(config.endpoint).port || DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
    const unlock = await lock(runtime); let bridge;
    try { bridge = await createBridge({ runtime, ...(options.desktop ? { desktopDir: path.resolve(options.desktop) } : {}) }); await bridge.listen(port); }
    catch (e) { await bridge?.close(); await unlock(); throw e; }
    console.log(JSON.stringify({ listening: true, port, protocolVersion: 1 }));
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await bridge.close(); await unlock(); };
    process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close()); return;
  }
  if (command === 'pair') {
    const endpoint = validEndpoint(options.endpoint || config.endpoint); let result;
    try { result = await request(config, '/v1/pairings', { method: 'POST', body: { endpoint } }); }
    catch (e) {
      if (e.code !== 'ECONNREFUSED') throw e;
      const unlock = await lock(runtime); let bridge;
      try { bridge = await createBridge({ runtime, ...(options.desktop ? { desktopDir: path.resolve(options.desktop) } : {}) }); result = await bridge.createPairing(endpoint); }
      finally { await bridge?.close(); await unlock(); }
    }
    if (options.show) console.log(JSON.stringify(await readPrivate(result.pairingFile)));
    else console.log(result.pairingFile);
    return;
  }
  if (command === 'status') { console.log(JSON.stringify(await request(config, '/v1/state'), null, 2)); return; }
  if (command === 'revoke') {
    if (!args[1]) throw new Error('Choose a device ID.');
    console.log(JSON.stringify(await request(config, `/v1/devices/${encodeURIComponent(args[1])}/revoke`, { method: 'POST', body: {} }))); return;
  }
  if (!args[1] || !options.device) throw new Error('Choose a file and --device UUID.');
  const filePath = path.resolve(args[1]), name = validName(path.basename(filePath));
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Send an ordinary file.');
  if (before.size > config.maxFileBytes) throw new Error('File exceeds bridge limit.');
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat(); if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size) throw new Error('File changed while opening.');
    console.log(JSON.stringify(await request(config, `/v1/outbox?name=${encodeURIComponent(name)}&deviceId=${encodeURIComponent(options.device)}`, { method: 'POST', stream: handle.createReadStream(), headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': after.size } })));
  } finally { await handle.close().catch(() => {}); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, argumentsFor, request };
