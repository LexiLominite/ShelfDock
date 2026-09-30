'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
test('glass canvas, readable surfaces, reduced transparency and independent reduced motion render correctly', {timeout: 20000}, async () => {
  const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><div id="root"><div class="app"><div class="titlebar">ShelfDock</div><div class="drop-tray">Readable shelf</div><button class="primary-button">Send</button><div class="modal">Settings</div><div class="machine-search"><input placeholder="Find a machine"></div></div></div></body></html>');
    await page.addStyleTag({content: fs.readFileSync(path.join(__dirname, '../../src/styles.css'), 'utf8')});
    const styles = () => page.evaluate(() => {
      const css = selector => getComputedStyle(document.querySelector(selector));
      return {html: css('html').backgroundColor, body: css('body').backgroundColor, root: css('#root').backgroundColor, app: css('.app').backgroundColor, tray: css('.drop-tray').backgroundColor, blur: css('.drop-tray').backdropFilter, primary: css('.primary-button').backgroundColor, modal: css('.modal').backgroundColor, titleInset: css('.titlebar').paddingLeft, drag: css('.titlebar').webkitAppRegion, controlDrag: css('input').webkitAppRegion};
    });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.drop-tray')).backgroundColor === 'rgb(250, 250, 253)');
    const base = await styles();
    assert.equal(base.html, 'rgb(232, 235, 246)'); assert.equal(base.app, 'rgb(232, 235, 246)'); assert.equal(base.tray, 'rgb(250, 250, 253)');
    await page.evaluate(() => { document.body.className = 'platform-darwin liquid-glass'; });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.drop-tray')).backgroundColor === 'rgba(250, 250, 253, 0.58)');
    const glass = await styles();
    for (const key of ['html', 'body', 'root']) assert.equal(glass[key], 'rgba(0, 0, 0, 0)', `${key} must expose the native material`);
    assert.equal(glass.tray, 'rgba(250, 250, 253, 0.58)'); assert.equal(glass.primary, 'rgb(99, 83, 217)');
    assert.match(glass.blur, /blur\(12px\)/); assert.equal(glass.titleInset, '82px');
    assert.equal(glass.drag, 'drag'); assert.equal(glass.controlDrag, 'no-drag');
    await page.emulateMedia({reducedMotion: 'reduce'});
    assert.equal((await styles()).blur, glass.blur, 'Static material remains when only motion is reduced');
    await page.evaluate(() => { document.documentElement.classList.add('reduced-transparency'); document.body.classList.add('reduced-transparency'); });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.drop-tray')).backgroundColor === 'rgb(250, 250, 253)');
    const solid = await styles();
    for (const key of ['html', 'body', 'root', 'app']) assert.equal(solid[key], 'rgb(232, 235, 246)');
    assert.equal(solid.tray, 'rgb(250, 250, 253)'); assert.equal(solid.modal, 'rgb(250, 250, 253)'); assert.equal(solid.blur, 'none'); assert.equal(solid.titleInset, '82px');
    await page.evaluate(() => { document.documentElement.className = ''; document.body.className = ''; });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.drop-tray')).backgroundColor === 'rgb(250, 250, 253)');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.titlebar')).paddingLeft === '29px' && getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)');
    assert.deepEqual(await styles(), base, 'Windows/Linux/browser palette survives removal of Mac classes');
  } finally { await browser.close(); }
});
