'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateClipboardPNG } = require('../desktop/clipboard.cjs');
const protocol = require('../desktop/clipboard-sync-protocol.cjs');

const {
  PORT, HOST, VERSION, MAX_FRAME, MAX_TEXT, MAX_PNG, FRESH_MS,
  encodeFrame, pushBytes, createCode, classifyText, assertFresh, rememberEvent, validateMessage,
} = protocol;

const SAMPLE = 'sync-sample-text';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=';
const FRAME_MALFORMED = 'The sync frame is malformed.';
const MESSAGE_MALFORMED = 'The sync message is malformed.';
const FRAME_TOO_LARGE = 'The sync frame is too large.';
const VERSION_UNSUPPORTED = 'The sync protocol version is not supported.';
const FORMAT_UNSUPPORTED = 'This clipboard format is not supported.';
const TEXT_TOO_LARGE = 'The clipboard text is too large.';
const IMAGE_TOO_LARGE = 'The clipboard image is too large.';
const IMAGE_INVALID = 'The clipboard image is not a valid PNG image.';
const NOT_FRESH = 'The clipboard item is not fresh.';

function expectThrow(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected an error.');
}

function assertSafe(error, expected) {
  if (!(error instanceof Error) || typeof error.message !== 'string' || error.message.length > 300 || error.message.includes(SAMPLE)) {
    throw new Error('Unsafe error message.');
  }
  assert.equal(error.message, expected);
}

function rawFrame(payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const frame = Buffer.alloc(4 + bytes.length);
  frame.writeUInt32BE(bytes.length, 0);
  bytes.copy(frame, 4);
  return frame;
}

function uuid() {
  return crypto.randomUUID();
}

function token() {
  return crypto.randomBytes(32).toString('hex');
}

function hello(extra = {}) {
  return { v: VERSION, type: 'hello', deviceId: uuid(), token: token(), ...extra };
}

function pair(extra = {}) {
  return { v: VERSION, type: 'pair', code: 'AB234567', deviceId: uuid(), label: SAMPLE, direction: 'both', ...extra };
}

function item(extra = {}) {
  return {
    v: VERSION,
    type: 'item',
    eventId: uuid(),
    originDeviceId: uuid(),
    kind: 'text',
    createdAt: 1_700_000_000_000,
    text: SAMPLE,
    ...extra,
  };
}

function emptyState() {
  return { buffer: Buffer.alloc(0) };
}

function feed(chunks) {
  let state = emptyState();
  const messages = [];
  for (const chunk of chunks) {
    const step = pushBytes(state, chunk);
    messages.push(...step.messages);
    state = step.state;
  }
  return { messages, state };
}

test('exports are the protocol constants and pure helpers', () => {
  assert.deepEqual(Object.keys(protocol).sort(), [
    'FRESH_MS', 'HOST', 'MAX_FRAME', 'MAX_PNG', 'MAX_TEXT', 'PORT', 'VERSION',
    'assertFresh', 'classifyText', 'createCode', 'encodeFrame', 'pushBytes', 'rememberEvent', 'validateMessage',
  ]);
  assert.equal(PORT, 47635);
  assert.equal(HOST, '127.0.0.1');
  assert.equal(VERSION, 1);
  assert.equal(MAX_FRAME, 9 * 1024 * 1024);
  assert.equal(MAX_TEXT, 1024 * 1024);
  assert.equal(MAX_PNG, 8 * 1024 * 1024);
  assert.equal(FRESH_MS, 120000);
});

test('frames are big-endian length prefixed and reassemble one byte at a time', () => {
  const message = hello();
  const frame = encodeFrame(message);
  assert.equal(frame.readUInt32BE(0), frame.length - 4);
  assert.notEqual(frame.readUInt32LE(0), frame.length - 4);
  assert.equal(frame[0], 0);
  const { messages, state } = feed([...frame].map(byte => Buffer.from([byte])));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], message);
  assert.equal(state.buffer.length, 0);
});

test('split chunks, back-to-back frames, and short reads yield no partial message', () => {
  const first = hello();
  const second = item({ kind: 'url', text: 'https://example.com/sync-sample-text' });
  const a = encodeFrame(first);
  const b = encodeFrame(second);
  const blob = Buffer.concat([a, b, Buffer.from([9, 8, 7])]);
  const cut = a.length + 3;
  const opened = pushBytes(emptyState(), blob.subarray(0, cut));
  assert.equal(opened.messages.length, 1);
  assert.deepEqual(opened.messages[0], first);
  assert.equal(opened.state.buffer.length, 3);
  const closed = pushBytes(opened.state, blob.subarray(cut));
  assert.equal(closed.messages.length, 1);
  assert.deepEqual(closed.messages[0], second);
  assert.deepEqual([...closed.state.buffer], [9, 8, 7]);

  const partial = pushBytes(emptyState(), a.subarray(0, a.length - 1));
  assert.deepEqual(partial.messages, []);
  assert.equal(partial.state.buffer.length, a.length - 1);
  const done = pushBytes(partial.state, a.subarray(a.length - 1));
  assert.deepEqual(done.messages, [first]);
  assert.equal(done.state.buffer.length, 0);

  const idle = pushBytes(done.state, Buffer.alloc(0));
  assert.deepEqual(idle.messages, []);
  assert.equal(idle.state.buffer.length, 0);
});

test('version, malformed JSON, non-objects, and oversized lengths fail closed', () => {
  assertSafe(expectThrow(() => validateMessage({ ...hello(), v: 2, text: SAMPLE })), VERSION_UNSUPPORTED);
  assertSafe(expectThrow(() => validateMessage({ type: 'hello', deviceId: uuid(), token: token(), text: SAMPLE })), VERSION_UNSUPPORTED);
  assertSafe(expectThrow(() => pushBytes(emptyState(), rawFrame(JSON.stringify({ v: 0, type: 'pause', deviceId: uuid(), text: SAMPLE })))), VERSION_UNSUPPORTED);

  assertSafe(expectThrow(() => pushBytes(emptyState(), rawFrame(`{"text":"${SAMPLE}"`))), FRAME_MALFORMED);
  assertSafe(expectThrow(() => pushBytes(emptyState(), rawFrame(Buffer.from([0xff, 0xfe, SAMPLE.charCodeAt(0)])))), FRAME_MALFORMED);
  assertSafe(expectThrow(() => pushBytes(emptyState(), rawFrame(JSON.stringify(SAMPLE)))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => pushBytes(emptyState(), rawFrame('null'))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => pushBytes(emptyState(), rawFrame('[]'))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage(SAMPLE)), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage(['hello'])), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => pushBytes(emptyState(), SAMPLE)), FRAME_MALFORMED);

  const early = pushBytes(emptyState(), rawFrame('{').subarray(0, 4));
  assert.deepEqual(early.messages, []);
  assertSafe(expectThrow(() => pushBytes(early.state, rawFrame('{').subarray(4))), FRAME_MALFORMED);

  const over = Buffer.alloc(4);
  over.writeUInt32BE(MAX_FRAME + 1, 0);
  const marked = Buffer.concat([over, Buffer.from(SAMPLE)]);
  assertSafe(expectThrow(() => pushBytes(emptyState(), marked)), FRAME_TOO_LARGE);
  const split = pushBytes(emptyState(), over.subarray(0, 2));
  assert.deepEqual(split.messages, []);
  assertSafe(expectThrow(() => pushBytes(split.state, Buffer.concat([over.subarray(2), Buffer.from(SAMPLE)]))), FRAME_TOO_LARGE);

  const maxHeader = Buffer.alloc(4);
  maxHeader.writeUInt32BE(MAX_FRAME, 0);
  const held = pushBytes(emptyState(), maxHeader);
  assert.deepEqual(held.messages, []);
  assert.equal(held.state.buffer.length, 4);
  const heldMore = pushBytes(held.state, Buffer.from([1]));
  assert.deepEqual(heldMore.messages, []);
  assert.equal(heldMore.state.buffer.length, 5);
});

test('text and URL classification uses the whole trimmed value', () => {
  assert.deepEqual(classifyText(SAMPLE), { kind: 'text', text: SAMPLE });
  assert.deepEqual(classifyText(`  ${SAMPLE}  `), { kind: 'text', text: `  ${SAMPLE}  ` });
  assert.deepEqual(classifyText(''), { kind: 'text', text: '' });
  assert.deepEqual(classifyText('see https://example.com'), { kind: 'text', text: 'see https://example.com' });
  assert.deepEqual(classifyText('ftp://example.com'), { kind: 'text', text: 'ftp://example.com' });
  assert.deepEqual(classifyText('http://'), { kind: 'text', text: 'http://' });
  assert.deepEqual(classifyText('https://example.com sync-sample-text'), { kind: 'text', text: 'https://example.com sync-sample-text' });
  for (const text of ['https://example.com', 'http://example.com/path?q=1', 'HTTPS://example.com', 'http://127.0.0.1:47635/', 'http://[::1]/', 'https://example.com/sync-sample-text']) {
    assert.deepEqual(classifyText(text), { kind: 'url', text });
  }
  const spaced = '  https://example.com/a  ';
  assert.deepEqual(classifyText(spaced), { kind: 'url', text: spaced });
  assertSafe(expectThrow(() => classifyText({ text: SAMPLE })), MESSAGE_MALFORMED);
});

test('PNG items must be canonical base64 under the size cap and a real PNG', () => {
  const png = Buffer.from(PNG_BASE64, 'base64');
  assert.deepEqual(validateClipboardPNG(png), png);
  const message = item({ kind: 'png', text: undefined, png: png.toString('base64') });
  delete message.text;
  const decoded = feed([encodeFrame(message)]).messages[0];
  assert.equal(decoded.kind, 'png');
  assert.equal(decoded.png === message.png, true);
  assert.equal(decoded.text, undefined);
  assert.equal(Buffer.from(decoded.png, 'base64').subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), true);

  assertSafe(expectThrow(() => validateMessage(item({ kind: 'png', text: undefined, png: undefined }))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage({ ...message, text: SAMPLE })), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage({ ...item(), png: PNG_BASE64 })), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage({ ...message, png: Buffer.from(SAMPLE).toString('base64') })), IMAGE_INVALID);
  assertSafe(expectThrow(() => validateMessage({ ...message, png: `data:image/png;base64,${PNG_BASE64}` })), IMAGE_INVALID);

  const truncated = png.subarray(0, png.length - 5).toString('base64');
  const signatureOnly = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const huge = Buffer.from(png);
  huge.writeUInt32BE(32769, 16);
  for (const bad of [truncated, signatureOnly, huge.toString('base64')]) {
    const error = expectThrow(() => validateMessage({ ...message, png: bad }));
    if (!(error instanceof Error) || error.message.length > 300 || error.message.includes(SAMPLE) || error.message.includes(bad)) {
      throw new Error('Unsafe error message.');
    }
    assert.match(error.message, /PNG|image|incomplete|large|malformed/i);
  }

  const maxChars = 4 * Math.ceil(MAX_PNG / 3);
  assertSafe(expectThrow(() => validateMessage({ ...message, png: 'A'.repeat(maxChars + 4) })), IMAGE_TOO_LARGE);
  assertSafe(expectThrow(() => validateMessage({ ...message, png: 'A'.repeat(maxChars) })), IMAGE_TOO_LARGE);
});

test('file, html, and rtf kinds are refused', () => {
  for (const kind of ['files', 'html', 'rtf', 'file', 'image', 'HTML']) {
    const error = expectThrow(() => validateMessage(item({ kind, text: SAMPLE })));
    assertSafe(error, FORMAT_UNSUPPORTED);
  }
  assertSafe(expectThrow(() => validateMessage({ v: VERSION, type: 'files', deviceId: uuid(), text: SAMPLE })), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage({ ...hello(), type: 'ping' })), MESSAGE_MALFORMED);
});

test('freshness allows the 120s and 5s boundaries and does not gate structural validation', () => {
  const now = 1_700_000_000_000;
  assertFresh(now, now);
  assertFresh(now - FRESH_MS, now);
  assertFresh(now + 5000, now);
  assertSafe(expectThrow(() => assertFresh(now - FRESH_MS - 1, now)), NOT_FRESH);
  assertSafe(expectThrow(() => assertFresh(now + 5001, now)), NOT_FRESH);
  assertSafe(expectThrow(() => assertFresh(SAMPLE, now)), NOT_FRESH);
  assertSafe(expectThrow(() => assertFresh(now, Number.POSITIVE_INFINITY)), NOT_FRESH);
  const stale = item({ createdAt: now - FRESH_MS - 1, text: SAMPLE });
  assert.equal(validateMessage(stale), stale);
});

test('duplicate event ids are ignored and memory stays capped at 500', () => {
  const ids = Array.from({ length: 501 }, () => uuid());
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) assert.equal(rememberEvent(seen, ids[i]), true);
  assert.equal(seen.size, 500);
  assert.equal(rememberEvent(seen, ids[0]), false);
  assert.equal(seen.size, 500);
  assert.equal(seen.values().next().value, ids[0]);
  assert.equal(rememberEvent(seen, ids[500]), true);
  assert.equal(seen.size, 500);
  assert.equal(seen.has(ids[0]), false);
  assert.equal(seen.has(ids[1]), true);
  assert.equal(seen.has(ids[500]), true);
  assert.equal(rememberEvent(seen, ids[500]), false);
  assert.equal(rememberEvent(seen, ids[0]), true);
  assertSafe(expectThrow(() => rememberEvent(seen, SAMPLE)), MESSAGE_MALFORMED);
  assert.equal(seen.has(ids[0]), true);
  assertSafe(expectThrow(() => rememberEvent(SAMPLE, ids[0])), MESSAGE_MALFORMED);
});

test('a text item error never includes the text', () => {
  const exact = 'a'.repeat(MAX_TEXT);
  const exactItem = item({ text: exact });
  assert.equal(validateMessage(exactItem).text.length, MAX_TEXT);
  const over = SAMPLE.repeat(Math.floor(MAX_TEXT / SAMPLE.length) + 1);
  assertSafe(expectThrow(() => validateMessage(item({ text: over }))), TEXT_TOO_LARGE);
  assertSafe(expectThrow(() => validateMessage(item({ text: '✓'.repeat(Math.floor(MAX_TEXT / 3) + 1) }))), TEXT_TOO_LARGE);
  assertSafe(expectThrow(() => encodeFrame(item({ text: over }))), TEXT_TOO_LARGE);
  assertSafe(expectThrow(() => validateMessage(item({ text: SAMPLE, png: PNG_BASE64 }))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => pushBytes(emptyState(), rawFrame(JSON.stringify({ v: VERSION, type: 'item', kind: 'text', text: SAMPLE })))), MESSAGE_MALFORMED);

  const framed = rawFrame(JSON.stringify(item({ text: SAMPLE })));
  const round = pushBytes(emptyState(), framed);
  assert.equal(round.messages.length, 1);
  assert.equal(round.messages[0].text === SAMPLE, true);
  assert.equal(round.messages[0].kind, 'text');
});

test('hello, pair, control, and reject messages accept only their stated shapes', () => {
  const paired = pair();
  const accepted = pair({ v: VERSION, type: 'pair-ok', code: undefined, token: token() });
  delete accepted.code;
  const controls = [
    hello(),
    paired,
    pair({ direction: 'send' }),
    pair({ direction: 'receive', label: 'a' }),
    pair({ label: 'L'.repeat(80) }),
    accepted,
    { v: VERSION, type: 'revoke', deviceId: uuid() },
    { v: VERSION, type: 'pause', deviceId: uuid() },
    { v: VERSION, type: 'resume', deviceId: uuid() },
    ...['version', 'auth', 'fresh', 'size', 'kind', 'malformed', 'paused', 'revoked', 'unpaired'].map(reason => ({ v: VERSION, type: 'reject', reason })),
  ];
  for (const message of controls) assert.deepEqual(feed([encodeFrame(message)]).messages[0], message);

  assertSafe(expectThrow(() => validateMessage(pair({ code: 'IIIIIIII' }))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage(pair({ code: 'oooooooo' }))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage(pair({ code: '00000000' }))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage(pair({ label: '' }))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage(pair({ label: 'L'.repeat(81) }))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage(pair({ direction: 'Send' }))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage(hello({ token: 'a'.repeat(63) }))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage(hello({ token: 'g'.repeat(64) }))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage(hello({ deviceId: 'not-a-uuid' }))), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage({ v: VERSION, type: 'reject', reason: 'nope' })), MESSAGE_MALFORMED);
  assertSafe(expectThrow(() => validateMessage({ v: VERSION, type: 'reject', reason: SAMPLE })), MESSAGE_MALFORMED);
  for (const char of 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') validateMessage(pair({ code: char.repeat(8) }));
  validateMessage(hello({ token: 'A'.repeat(64), deviceId: uuid().toUpperCase() }));
});

test('pairing codes are 8 characters from the unambiguous alphabet', () => {
  const alphabet = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
  const codes = Array.from({ length: 40 }, () => createCode());
  for (const code of codes) assert.match(code, alphabet);
  assert.equal(new Set(codes).size > 1, true);
  validateMessage(pair({ code: codes[0] }));
});
