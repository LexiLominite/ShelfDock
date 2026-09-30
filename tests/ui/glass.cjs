'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const rgba = (value) => value.match(/[\d.]+/g).map(Number);
const over = (foreground, backdrop) => foreground.slice(0, 3).map((value, i) => value * (foreground[3] ?? 1) + backdrop[i] * (1 - (foreground[3] ?? 1)));
const luminance = (rgb) => rgb.map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
const contrast = (ink, background) => { const values = [luminance(ink), luminance(background)].sort((a, b) => b - a); return (values[0] + .05) / (values[1] + .05); };
test('Mac smoked graphite has readable composed layers and solid fallback; non-Mac remains unchanged', { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><div id="root"><div class="app"><div class="titlebar">ShelfDock</div><div class="drop-tray">Readable shelf</div><button class="primary-button">Send</button><button class="quiet-button">Choose</button><span class="selected-check">✓</span><div class="updates-review">Update</div><div class="remote-install-review"><dl><dt>Target</dt><dd>Studio</dd></dl></div><div class="modal">Settings</div><div class="machine-context-menu">Menu</div><div class="history-panel">History</div><div class="clipboard-list">Clipboard</div><div class="machine-search"><input placeholder="Find a machine"></div><div class="field"><input value="SSH"><select><option>Studio</option></select></div><textarea>Forward notes</textarea><div class="app-footer">Footer</div></div></div></body></html>');
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../../src/styles.css'), 'utf8') });
    await page.addStyleTag({ content: ['updates.css', 'remote-install.css'].map(name => fs.readFileSync(path.join(__dirname, '../../src', name), 'utf8')).join('\n') });
    await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; }' });
    const styles = () => page.evaluate(() => {
      const css = selector => getComputedStyle(document.querySelector(selector));
      const body = css('body');
      return { html: css('html').backgroundColor, body: body.backgroundColor, root: css('#root').backgroundColor, app: css('.app').backgroundColor, tray: css('.drop-tray').backgroundColor, blur: css('.drop-tray').backdropFilter, primary: css('.primary-button').backgroundColor, primaryInk: css('.primary-button').color, check: css('.selected-check').backgroundColor, updateReview: css('.updates-review').backgroundColor, installReview: css('.remote-install-review dl').backgroundColor, modal: css('.modal').backgroundColor, menu: css('.machine-context-menu').backgroundColor, history: css('.history-panel').backgroundColor, clipboard: css('.clipboard-list').backgroundColor, search: css('.machine-search').backgroundColor, input: css('.field input').backgroundColor, select: css('select').backgroundColor, textarea: css('textarea').backgroundColor, footer: css('.app-footer').backgroundColor, titleInset: css('.titlebar').paddingLeft, drag: css('.titlebar').webkitAppRegion, controlDrag: css('input').webkitAppRegion, ink: body.color, muted: body.getPropertyValue('--muted').trim(), accent: body.getPropertyValue('--accent').trim(), hover: body.getPropertyValue('--surface-hover').trim(), soft: body.getPropertyValue('--accent-soft').trim(), primaryHover: body.getPropertyValue('--primary-hover').trim() };
    });
    const base = await styles();
    assert.equal(base.html, 'rgb(232, 235, 246)'); assert.equal(base.tray, 'rgb(250, 250, 253)');
    await page.evaluate(() => { document.documentElement.className = 'platform-darwin liquid-glass'; document.body.className = 'platform-darwin liquid-glass'; });
    const glass = await styles();
    for (const key of ['html', 'body', 'root']) assert.equal(glass[key], 'rgba(0, 0, 0, 0)', `${key} exposes native material`);
    assert.equal(glass.app, 'rgba(20, 22, 29, 0.82)');
    assert.equal(glass.tray, 'rgba(33, 35, 44, 0.76)');
    assert.equal(glass.modal, 'rgba(27, 29, 37, 0.96)');
    assert.equal(glass.menu, glass.modal); assert.equal(glass.history, glass.modal);
    assert.equal(glass.clipboard, glass.tray);
    for (const key of ['search', 'input', 'select', 'textarea']) assert.equal(glass[key], 'rgba(43, 45, 56, 0.92)', `${key} avoids pale inputs`);
    assert.equal(glass.check, glass.primary); assert.equal(glass.updateReview, glass.tray); assert.equal(glass.installReview, 'rgba(52, 55, 68, 0.94)');
    assert.equal(glass.primary, 'rgb(105, 80, 206)'); assert.equal(glass.primaryInk, 'rgb(255, 255, 255)');
    assert.match(glass.blur, /blur\(12px\)/); assert.equal(glass.titleInset, '82px');
    assert.equal(glass.drag, 'drag'); assert.equal(glass.controlDrag, 'no-drag');
    const hex = value => value.slice(1).match(/../g).map(value => parseInt(value, 16));
    for (const backdrop of [[0, 0, 0], [255, 255, 255]]) {
      const app = over(rgba(glass.app), backdrop);
      // Bare headings/footer/machine labels live directly on the root scrim.
      const backgrounds = [app, ...['tray', 'modal', 'input', 'clipboard'].map(key => over(rgba(glass[key]), app)), over(rgba(glass.hover), app), over(rgba(glass.soft), app)];
      for (const [name, ink] of [['ink', rgba(glass.ink)], ['secondary', hex(glass.muted)], ['accent', hex(glass.accent)]]) {
        for (const background of backgrounds) assert.ok(contrast(ink, background) >= 4.5, `${name} contrast ${contrast(ink, background).toFixed(2)} over ${backdrop[0] ? 'white' : 'black'} desktop`);
      }
    }
    assert.ok(contrast(rgba(glass.primaryInk), rgba(glass.primary)) >= 4.5);
    assert.ok(contrast(rgba(glass.primaryInk), hex(glass.primaryHover)) >= 4.5);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal((await styles()).blur, glass.blur);
    await page.evaluate(() => { document.documentElement.className = 'platform-darwin reduced-transparency'; document.body.className = 'platform-darwin reduced-transparency'; });
    const solid = await styles();
    for (const key of ['html', 'body', 'root', 'app']) assert.equal(solid[key], 'rgb(28, 29, 36)');
    assert.equal(solid.tray, 'rgb(35, 37, 46)'); assert.equal(solid.modal, solid.tray); assert.equal(solid.blur, 'none'); assert.equal(solid.titleInset, '82px');
    for (const key of ['search', 'input', 'select', 'textarea']) assert.equal(solid[key], 'rgb(43, 45, 56)');
    await page.evaluate(() => { document.documentElement.className = ''; document.body.className = ''; });
    assert.deepEqual(await styles(), base, 'Non-Mac palette and dimensions are unchanged');
  } finally { await browser.close(); }
});
