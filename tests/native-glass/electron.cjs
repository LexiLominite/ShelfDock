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
  assert.equal(window.isVisible(), false);
  console.log(JSON.stringify({status, nativeState: state, resize: '900x700', focus: 'input', action: 'clicked', visible: false}));
  window.destroy(); window = null;
  app.exit(0);
}).catch(error => {
  console.error(error.stack || error);
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
});
