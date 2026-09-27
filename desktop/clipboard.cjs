'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const MAX_CLIPBOARD_BYTES = 20 * 1024 * 1024;
const MAX_URI_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function validateClipboardPNG(input) {
  if (!(Buffer.isBuffer(input) || input instanceof Uint8Array)) throw new Error('The clipboard image is not a PNG image.');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > MAX_CLIPBOARD_BYTES) throw new Error('Clipboard images can contain up to 20 MB.');
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('The clipboard image is not a valid PNG image.');
  let offset = 8; let hasImageData = false; let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset); const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12) throw new Error('The clipboard image is incomplete.');
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) throw new Error('The clipboard image has no PNG header.');
      const width = bytes.readUInt32BE(offset + 8); const height = bytes.readUInt32BE(offset + 12);
      if (!width || !height || width > 32768 || height > 32768 || width * height > 32 * 1024 * 1024) throw new Error('The clipboard image is too large. Use an image file instead.');
    }
    if (type === 'IDAT') hasImageData = true;
    offset += length + 12;
    if (type === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
  }
  if (!hasImageData || !ended) throw new Error('The clipboard image is incomplete.');
  return bytes;
}

function parseFileURIs(text, platform = process.platform) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_URI_BYTES) throw new Error('The copied file list is too large.');
  const paths = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!/^file:\/\//i.test(line)) throw new Error('Clipboard files must be local files. Remote links cannot be added as files.');
    let url; let file;
    try {
      url = new URL(line);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname.toLowerCase() !== 'localhost') || url.search || url.hash) throw new Error('Not a local file URL.');
      file = fileURLToPath(url, { windows: platform === 'win32' });
    } catch { throw new Error('The clipboard contains an invalid or remote file path.'); }
    if (/[\x00-\x1f\x7f]/.test(file) || file.length > 4096 || !(platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(file) && path.win32.isAbsolute(file) : path.posix.isAbsolute(file))) throw new Error('The clipboard contains an invalid local file path.');
    if (!paths.includes(file)) paths.push(file);
    if (paths.length > 500) throw new Error('Copy at most 500 files or folders at once.');
  }
  if (!paths.length) throw new Error('The clipboard does not contain local files.');
  return paths;
}

async function readBytes(item, type, limit = MAX_CLIPBOARD_BYTES) {
  const blob = await item.getType(type);
  if (!blob || typeof blob.arrayBuffer !== 'function' || !Number.isFinite(blob.size)) throw new Error('This clipboard format could not be read.');
  if (blob.size > limit) throw new Error(type === 'text/uri-list' ? 'The copied file list is too large.' : 'Clipboard items can contain up to 20 MB.');
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.length > limit) throw new Error('The clipboard item is too large.');
  return bytes;
}

async function readText(item, type, limit) {
  const bytes = await readBytes(item, type, limit);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('The clipboard text could not be decoded as UTF-8.'); }
}

async function captureClipboard({ clipboard, service, platform = process.platform }) {
  if (!clipboard || typeof clipboard.read !== 'function') throw new Error('Native clipboard support is unavailable.');
  if (service.configurationImport) throw new Error('Wait for configuration import to finish.');
  const items = await clipboard.read();
  if (service.configurationImport) throw new Error('Wait for configuration import to finish.');
  if (!Array.isArray(items) || !items.length) throw new Error('The clipboard is empty. Copy text, an image, or local files first.');
  if (items.length > 500) throw new Error('Copy at most 500 clipboard items at once.');
  const matching = type => items.filter(item => Array.isArray(item.types) && item.types.includes(type));
  const fileItems = matching('text/uri-list');
  if (fileItems.length) {
    const files = [];
    for (const item of fileItems) files.push(...parseFileURIs(await readText(item, 'text/uri-list', MAX_URI_BYTES), platform));
    const unique = [...new Set(files)];
    if (unique.length > 500) throw new Error('Copy at most 500 files or folders at once.');
    return service.enqueueFiles(unique);
  }
  const image = matching('image/png')[0];
  if (image) return service.enqueueClipboardImage(validateClipboardPNG(await readBytes(image, 'image/png')));
  const text = matching('text/plain')[0];
  if (text) return service.enqueueText(await readText(text, 'text/plain', MAX_CLIPBOARD_BYTES));
  throw new Error('Copy plain text, a screenshot/image, or local files first. This clipboard format is not supported.');
}

module.exports = { captureClipboard, parseFileURIs, validateClipboardPNG, MAX_CLIPBOARD_BYTES };
