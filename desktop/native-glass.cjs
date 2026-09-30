'use strict';
// Main process only. N-API has a stable ABI; no Electron-specific rebuild or
// third-party binary download is involved. Mac packages copy the .node file
// outside ASAR through their native/ extra resource; other targets exclude it.
function loadNativeModule() {
  const fs = require('node:fs');
  const path = require('node:path');
  const external = process.resourcesPath && path.join(process.resourcesPath, 'native/shelfdock-glass.node');
  return require(external && fs.existsSync(external) ? external : './native/shelfdock-glass.node');
}
function createNativeGlassAdapter({platform = process.platform, load = loadNativeModule} = {}) {
  let native, loadError;
  function backend() {
    if (platform !== 'darwin') return null;
    if (!native && !loadError) { try { native = load(); } catch (error) { loadError = error; } }
    return native;
  }
  function unavailable() {
    return {supported: false, applied: false, reducedTransparency: false, reducedMotion: false, mode: platform === 'darwin' ? 'vibrancy' : 'solid', reason: platform === 'darwin' ? 'native-module-unavailable' : 'platform-unsupported'};
  }
  function withMode(status) {
    return {...status, mode: status.reducedTransparency ? 'solid' : status.applied || status.supported ? 'native' : 'vibrancy'};
  }
  function getNativeGlassStatus() {
    const module = backend();
    return module ? withMode(module.getStatus()) : unavailable();
  }
  function applyNativeGlass(window, {cornerRadius = 18, style = 'regular'} = {}) {
    const module = backend();
    if (!window || window.isDestroyed?.() || typeof window.getNativeWindowHandle !== 'function') return {...getNativeGlassStatus(), applied: false, reason: 'window-unavailable'};
    const availability = getNativeGlassStatus();
    if (availability.reducedTransparency) {
      // Restore Electron's original view before changing its background/vibrancy.
      if (module) module.remove(window.getNativeWindowHandle());
      window.setVibrancy?.(null);
      window.setBackgroundColor?.('#E8EBF6');
      return {...availability, applied: false, mode: 'solid', reason: 'reduced-transparency'};
    }
    if (module && availability.supported) {
      try {
        // Remove Electron's older NSVisualEffectView before wrapping its content.
        window.setVibrancy?.(null);
        const status = module.apply(window.getNativeWindowHandle(), Number.isFinite(cornerRadius) ? cornerRadius : 18, style === 'clear');
        if (status.applied) { window.setBackgroundColor?.('#00000000'); return {...status, mode: 'native'}; }
      } catch { /* Keep the normal older-macOS vibrancy fallback. */ }
    }
    if (platform === 'darwin') { window.setBackgroundColor?.('#00000000'); window.setVibrancy?.('under-window'); }
    return {...availability, applied: false, mode: platform === 'darwin' ? 'vibrancy' : 'solid'};
  }
  function removeNativeGlass(window) {
    const module = backend();
    if (!module || !window || window.isDestroyed?.() || typeof window.getNativeWindowHandle !== 'function') return unavailable();
    try { return {...module.remove(window.getNativeWindowHandle()), mode: platform === 'darwin' ? 'vibrancy' : 'solid'}; }
    catch { return {...getNativeGlassStatus(), applied: false, reason: 'native-remove-failed'}; }
  }
  function watchAccessibility(callback) {
    const module = backend();
    if (!module?.watchAccessibility) return () => {};
    const token = module.watchAccessibility(status => callback(withMode(status)));
    let watching = true;
    return () => { if (watching) { watching = false; module.unwatchAccessibility(token); } };
  }
  return {applyNativeGlass, removeNativeGlass, getNativeGlassStatus, watchAccessibility};
}
module.exports = {...createNativeGlassAdapter(), createNativeGlassAdapter};
