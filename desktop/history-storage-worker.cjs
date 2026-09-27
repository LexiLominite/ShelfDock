'use strict';
// Serialization and encryption of bounded history stay off Electron's UI thread.
const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
const iv = crypto.randomBytes(12);
const key = Buffer.from(workerData.key);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(JSON.stringify(workerData.saved), 'utf8'), cipher.final()]);
const result = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
key.fill(0);
parentPort.postMessage(result);
