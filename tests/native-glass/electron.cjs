'use strict';
// Completely isolated Electron fixture: no production controller, services,
// worker, clipboard, profiles, tray, shortcut or real network is loaded.
const {app, BrowserWindow, nativeTheme} = require('electron');
const assert = require('node:assert/strict');
app.setPath('userData', process.env.SHELFDOCK_GLASS_TEST_PROFILE);
app.setActivationPolicy('prohibited');
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('disable-background-networking');
let window;
app.whenReady().then(async () => {
  // Exercise the explicit glass appearance even when Electron prefers light.
  nativeTheme.themeSource = 'light';
  const glass = require('../../desktop/native-glass.cjs');
  const native = require('../../desktop/native/shelfdock-glass.node');
  window = new BrowserWindow({width: 640, height: 540, show: false, frame: false, titleBarStyle: 'hiddenInset', trafficLightPosition: {x:18,y:22}, transparent: true, backgroundColor: '#00000000', vibrancy: 'under-window', webPreferences: {sandbox: true, contextIsolation: true, backgroundThrottling: false}});
  console.log(JSON.stringify({before:native.inspect(window.getNativeWindowHandle()),contentSize:window.getContentSize()}));
  const status = glass.applyNativeGlass(window);
  assert.equal(status.mode, status.reducedTransparency ? 'solid' : status.supported ? 'native' : 'vibrancy');
  let state = native.inspect(window.getNativeWindowHandle());
  assert.equal(state.visible, false);
  if (status.applied) { assert.equal(state.nativeGlass, true); assert.equal(state.contentAttached, true); assert.equal(state.containerClass, 'NSGlassEffectView'); assert.equal(state.effectiveDarkAqua, true); assert.equal(state.untinted, true); }
  await window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><html style="background:transparent"><body style="background:transparent"><input id="input"><button id="button">Drop target</button><script>document.getElementById("button").onclick=()=>document.body.dataset.clicked="yes";</script></body></html>'));
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("input").focus(); document.activeElement.id'), 'input');
  assert.equal(await window.webContents.executeJavaScript('document.getElementById("button").click(); document.body.dataset.clicked'), 'yes');
  window.setContentSize(900, 700);
  await new Promise(resolve => setTimeout(resolve, 120));
  state = native.inspect(window.getNativeWindowHandle());
  console.log(JSON.stringify({resizedNativeState: state, electronContentSize:window.getContentSize()}));
  if (status.applied) {
    assert.equal(state.contentAttached, true);
    assert.equal(state.effectiveDarkAqua, true);
    assert.equal(state.untinted, true);
    assert.ok(Math.abs(state.glassWidth - 900) <= 1);
    assert.ok(Math.abs(state.contentWidth - 900) <= 1);
    assert.ok(Math.abs(state.contentHeight - 700) <= 1);
    assert.equal(glass.applyNativeGlass(window).applied, true);
    assert.equal(glass.removeNativeGlass(window).reason, 'removed');
    assert.equal(native.inspect(window.getNativeWindowHandle()).nativeGlass, false);
    assert.equal(glass.applyNativeGlass(window).applied, true);
    assert.equal(await window.webContents.executeJavaScript('document.getElementById("input").focus(); document.activeElement.id'), 'input');
  }
  const stop = glass.watchAccessibility(() => {}); stop(); stop();
  assert.equal(typeof native.postAccessibilityForTest, 'function');
  assert.equal(typeof native.queueAccessibilityForTest, 'function');
  let activeCallbacks = 0;
  const activeToken = native.watchAccessibility(value => { assert.equal(value.reason, 'accessibility-changed'); activeCallbacks++; });
  native.postAccessibilityForTest(); native.postAccessibilityForTest();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(activeCallbacks, 2);
  native.unwatchAccessibility(activeToken); native.unwatchAccessibility(activeToken);
  native.postAccessibilityForTest(); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(activeCallbacks, 2);
  let selfCallbacks = 0, selfToken;
  selfToken = native.watchAccessibility(() => { selfCallbacks++; native.unwatchAccessibility(selfToken); });
  native.postAccessibilityForTest(); native.postAccessibilityForTest();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(selfCallbacks, 1);
  let queuedCallbacks = 0;
  const queuedToken = native.watchAccessibility(() => { queuedCallbacks++; });
  native.queueAccessibilityForTest(queuedToken);
  native.unwatchAccessibility(queuedToken);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(queuedCallbacks, 0);
  let throwingCallbacks = 0;
  const throwingToken = native.watchAccessibility(() => { throwingCallbacks++; if (throwingCallbacks === 1) throw new Error('Synthetic accessibility callback failure'); });
  native.postAccessibilityForTest(); native.postAccessibilityForTest();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(throwingCallbacks, 2);
  native.unwatchAccessibility(throwingToken);
  console.log(JSON.stringify({accessibility: {activeCallbacks, selfCallbacks, queuedCallbacks, throwingCallbacks}, preferencesChanged: false}));
  assert.equal(window.isVisible(), false);
  console.log(JSON.stringify({status, nativeState: state, resize: '900x700', focus: 'input', action: 'clicked', visible: false}));
  window.destroy(); window = null;
  app.exit(0);
}).catch(error => {
  console.error(error.stack || error);
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
});
