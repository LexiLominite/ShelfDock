'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {createNativeGlassAdapter} = require('../desktop/native-glass.cjs');
function fixture(status = {supported: true, reducedTransparency: false, reducedMotion: false}) {
  const calls = [];
  const handle = Buffer.alloc(8);
  const native = {getStatus: () => ({...status, applied: false, reason: 'available'}), apply: (h, radius, clear) => { calls.push(['apply', h === handle, radius, clear]); return {...status, applied: true, reason: 'applied'}; }, remove: h => { calls.push(['remove', h === handle]); return {...status, applied: false, reason: 'removed'}; }, watchAccessibility: callback => { native.callback = callback; return 4; }, unwatchAccessibility: token => calls.push(['unwatch', token])};
  const window = {getNativeWindowHandle: () => handle, isDestroyed: () => false, setVibrancy: value => calls.push(['vibrancy', value]), setBackgroundColor: value => calls.push(['background', value])};
  return {adapter: createNativeGlassAdapter({platform: 'darwin', load: () => native}), native, window, calls};
}
test('real native glass replaces old vibrancy before wrapping the Electron view', () => {
  const {adapter, window, calls} = fixture();
  const result = adapter.applyNativeGlass(window, {cornerRadius: 20, style: 'clear'});
  assert.equal(result.mode, 'native');
  assert.equal(result.applied, true);
  assert.deepEqual(calls, [['vibrancy', null], ['apply', true, 20, true], ['background', '#00000000']]);
});
test('Reduce Transparency restores the original view and solid canvas', () => {
  const {adapter, window, calls} = fixture({supported: true, reducedTransparency: true, reducedMotion: false});
  const result = adapter.applyNativeGlass(window);
  assert.equal(result.mode, 'solid');
  assert.equal(result.applied, false);
  assert.deepEqual(calls, [['remove', true], ['vibrancy', null], ['background', '#E8EBF6']]);
});
test('Reduce Motion keeps native glass independently of transparency', () => {
  const {adapter, window} = fixture({supported: true, reducedTransparency: false, reducedMotion: true});
  const result = adapter.applyNativeGlass(window);
  assert.equal(result.mode, 'native'); assert.equal(result.reducedMotion, true);
});
test('older macOS or missing addon keeps vibrancy; non-Mac never loads addon', () => {
  const {adapter, window, calls} = fixture({supported: false, reducedTransparency: false});
  assert.equal(adapter.applyNativeGlass(window).mode, 'vibrancy');
  assert.deepEqual(calls, [['background', '#00000000'], ['vibrancy', 'under-window']]);
  let loads = 0;
  const missing = createNativeGlassAdapter({platform: 'darwin', load: () => { loads++; throw Error('missing'); }});
  assert.equal(missing.applyNativeGlass(window).reason, 'native-module-unavailable');
  missing.getNativeGlassStatus(); assert.equal(loads, 1);
  const linux = createNativeGlassAdapter({platform: 'linux', load: () => { throw Error('must not load'); }});
  assert.equal(linux.getNativeGlassStatus().mode, 'solid');
});
test('accessibility subscriptions update mode and unsubscribe exactly once', () => {
  const {adapter, native, calls} = fixture();
  let changed;
  const stop = adapter.watchAccessibility(status => changed = status);
  native.callback({supported: true, reducedTransparency: true});
  assert.equal(changed.mode, 'solid'); stop(); stop();
  assert.deepEqual(calls, [['unwatch', 4]]);
});
test('destroyed windows are never handed to the native pointer reader', () => {
  const {adapter, window, calls} = fixture(); window.isDestroyed = () => true;
  assert.equal(adapter.applyNativeGlass(window).reason, 'window-unavailable');
  assert.deepEqual(calls, []);
});
test('compiled AppKit harness validates invisible real glass ownership and input geometry', {skip: process.platform !== 'darwin', timeout: 20000}, () => {
  const {build} = require('../scripts/build-native-glass.cjs');
  const {output} = build({test: true});
  const text = execFileSync(output, [], {encoding: 'utf8', timeout: 10000});
  assert.match(text, /no visible window/);
});
