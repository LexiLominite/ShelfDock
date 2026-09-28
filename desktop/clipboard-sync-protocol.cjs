'use strict';

const { randomInt } = require('node:crypto');
const { validateClipboardPNG } = require('./clipboard.cjs');

const PORT = 47635;
const HOST = '127.0.0.1';
const VERSION = 1;
const MAX_FRAME = 9 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_PNG = 8 * 1024 * 1024;
const FRESH_MS = 120000;
// Items dated more than 5s ahead of the peer clock are rejected.
const FUTURE_MS = 5000;
const MAX_EVENTS = 500;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{8}$`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/i;
const REJECT_REASONS = new Set(['version', 'auth', 'fresh', 'size', 'kind', 'malformed', 'paused', 'revoked', 'unpaired']);
const DIRECTIONS = new Set(['send', 'receive', 'both']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const MAX_PNG_BASE64 = 4 * Math.ceil(MAX_PNG / 3);

const FRAME_MALFORMED = 'The sync frame is malformed.';
const MESSAGE_MALFORMED = 'The sync message is malformed.';
const FRAME_TOO_LARGE = 'The sync frame is too large.';
const VERSION_UNSUPPORTED = 'The sync protocol version is not supported.';
const FORMAT_UNSUPPORTED = 'This clipboard format is not supported.';
const TEXT_TOO_LARGE = 'The clipboard text is too large.';
const IMAGE_TOO_LARGE = 'The clipboard image is too large.';
const IMAGE_INVALID = 'The clipboard image is not a valid PNG image.';
const NOT_FRESH = 'The clipboard item is not fresh.';

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireUuid(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(MESSAGE_MALFORMED);
}

function requireToken(value) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) fail(MESSAGE_MALFORMED);
}

function requireLabel(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 80) fail(MESSAGE_MALFORMED);
}

function requireDirection(value) {
  if (typeof value !== 'string' || !DIRECTIONS.has(value)) fail(MESSAGE_MALFORMED);
}

function requireCode(value) {
  if (typeof value !== 'string' || !CODE_RE.test(value)) fail(MESSAGE_MALFORMED);
}

function requirePng(value) {
  if (typeof value !== 'string') fail(MESSAGE_MALFORMED);
  if (value.length > MAX_PNG_BASE64) fail(IMAGE_TOO_LARGE);
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(IMAGE_INVALID);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail(IMAGE_INVALID);
  if (bytes.length > MAX_PNG) fail(IMAGE_TOO_LARGE);
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) fail(IMAGE_INVALID);
  // Full chunk structure, not only the 8-byte signature. No Electron dependency.
  validateClipboardPNG(bytes);
}

function validateItem(message) {
  requireUuid(message.eventId);
  requireUuid(message.originDeviceId);
  if (typeof message.createdAt !== 'number' || !Number.isFinite(message.createdAt)) fail(MESSAGE_MALFORMED);
  const { kind } = message;
  if (kind === 'text' || kind === 'url') {
    if (message.png !== undefined) fail(MESSAGE_MALFORMED);
    if (typeof message.text !== 'string') fail(MESSAGE_MALFORMED);
    if (Buffer.byteLength(message.text, 'utf8') > MAX_TEXT) fail(TEXT_TOO_LARGE);
    return message;
  }
  if (kind === 'png') {
    if (message.text !== undefined) fail(MESSAGE_MALFORMED);
    requirePng(message.png);
    return message;
  }
  if (typeof kind === 'string') fail(FORMAT_UNSUPPORTED);
  fail(MESSAGE_MALFORMED);
}

function validateMessage(message) {
  if (!isRecord(message)) fail(MESSAGE_MALFORMED);
  if (message.v !== VERSION) fail(VERSION_UNSUPPORTED);
  switch (message.type) {
    case 'hello':
      requireUuid(message.deviceId);
      requireToken(message.token);
      return message;
    case 'pair':
      requireCode(message.code);
      requireUuid(message.deviceId);
      requireLabel(message.label);
      requireDirection(message.direction);
      return message;
    case 'pair-ok':
      requireUuid(message.deviceId);
      requireLabel(message.label);
      requireToken(message.token);
      requireDirection(message.direction);
      return message;
    case 'item':
      return validateItem(message);
    case 'reject':
      if (typeof message.reason !== 'string' || !REJECT_REASONS.has(message.reason)) fail(MESSAGE_MALFORMED);
      return message;
    case 'revoke':
    case 'pause':
    case 'resume':
      requireUuid(message.deviceId);
      return message;
    default:
      fail(MESSAGE_MALFORMED);
  }
}

function encodeFrame(message) {
  validateMessage(message);
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(message), 'utf8');
  } catch {
    fail(MESSAGE_MALFORMED);
  }
  if (payload.length > MAX_FRAME) fail(FRAME_TOO_LARGE);
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function asBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  fail(FRAME_MALFORMED);
}

function decodePayload(payload) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    // Decoder errors can echo bytes. Replace them.
    fail(FRAME_MALFORMED);
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    // JSON parser errors quote the frame. Never rethrow them.
    fail(FRAME_MALFORMED);
  }
  return validateMessage(message);
}

function pushBytes(state, chunk) {
  if (state != null && !isRecord(state)) fail(FRAME_MALFORMED);
  const pending = state && state.buffer != null && state.buffer.length ? asBytes(state.buffer) : Buffer.alloc(0);
  const incoming = asBytes(chunk);
  let pendingOffset = 0;
  let incomingOffset = 0;
  const messages = [];

  function available() {
    return (pending.length - pendingOffset) + (incoming.length - incomingOffset);
  }

  function read(count) {
    if (count === 0) return Buffer.alloc(0);
    if (available() < count) fail(FRAME_MALFORMED);
    const out = Buffer.alloc(count);
    let filled = 0;
    const pendingLeft = pending.length - pendingOffset;
    if (pendingLeft > 0) {
      const take = Math.min(pendingLeft, count);
      pending.copy(out, 0, pendingOffset, pendingOffset + take);
      pendingOffset += take;
      filled = take;
    }
    if (filled < count) {
      const take = count - filled;
      incoming.copy(out, filled, incomingOffset, incomingOffset + take);
      incomingOffset += take;
    }
    return out;
  }

  while (available() >= 4) {
    const markPending = pendingOffset;
    const markIncoming = incomingOffset;
    const length = read(4).readUInt32BE(0);
    if (length > MAX_FRAME) fail(FRAME_TOO_LARGE);
    if (available() < length) {
      pendingOffset = markPending;
      incomingOffset = markIncoming;
      break;
    }
    messages.push(decodePayload(read(length)));
  }

  const rest = available();
  return { messages, state: { buffer: rest ? read(rest) : Buffer.alloc(0) } };
}

function createCode() {
  let code = '';
  for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function classifyText(text) {
  if (typeof text !== 'string') fail(MESSAGE_MALFORMED);
  const trimmed = text.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) return { kind: 'url', text };
    } catch {
      // Invalid URL text stays plain text. Do not log the value.
    }
  }
  return { kind: 'text', text };
}

function assertFresh(createdAt, now) {
  if (typeof createdAt !== 'number' || typeof now !== 'number' || !Number.isFinite(createdAt) || !Number.isFinite(now)) fail(NOT_FRESH);
  if (now - createdAt > FRESH_MS || createdAt - now > FUTURE_MS) fail(NOT_FRESH);
}

function rememberEvent(set, eventId) {
  if (!(set instanceof Set) || typeof eventId !== 'string' || !UUID_RE.test(eventId)) fail(MESSAGE_MALFORMED);
  if (set.has(eventId)) return false;
  set.add(eventId);
  while (set.size > MAX_EVENTS) set.delete(set.values().next().value);
  return true;
}

module.exports = {
  PORT,
  HOST,
  VERSION,
  MAX_FRAME,
  MAX_TEXT,
  MAX_PNG,
  FRESH_MS,
  encodeFrame,
  pushBytes,
  createCode,
  classifyText,
  assertFresh,
  rememberEvent,
  validateMessage,
};
