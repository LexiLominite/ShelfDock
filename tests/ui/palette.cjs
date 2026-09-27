'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const harness = require('./harness.cjs');

const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
const luminance = color => color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
const evidence = [];

async function check(page, selector, kind = 'text', pseudo = null) {
  const element = page.locator(selector).first();
  if (!await element.isVisible()) return;
  const colors = await element.evaluate((element, {kind, pseudo}) => {
    const channels = value => value.match(/[\d.]+/g).map(Number);
    const blend = (fg, bg) => fg.slice(0, 3).map((v, i) => v * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
    const ancestors = []; for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
    const background = ancestors.reduce((bg, node) => blend(channels(getComputedStyle(node).backgroundColor), bg), [255, 255, 255]);
    const style = getComputedStyle(element, pseudo);
    const opacity = ancestors.reduce((value, node) => value * Number(getComputedStyle(node).opacity), 1) * (pseudo ? Number(style.opacity) : 1);
    const value = kind === 'border' ? style.borderTopColor : kind === 'focus' ? style.outlineColor : style.color;
    const foreground = channels(value); foreground[3] = (foreground[3] ?? 1) * opacity;
    return {foreground: blend(foreground, background), background, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth};
  }, {kind, pseudo});
  const ratio = contrast(colors.foreground, colors.background), minimum = kind === 'text' ? 4.5 : 3;
  if (kind === 'focus') assert.ok(colors.outlineStyle !== 'none' && parseFloat(colors.outlineWidth) >= 2, `${selector}: missing focus outline`);
  assert.ok(ratio >= minimum, `${selector}${pseudo || ''}: ${kind} contrast ${ratio.toFixed(3)} < ${minimum}`);
  evidence.push({selector, kind, pseudo, ratio: Number(ratio.toFixed(3)), minimum});
}

(async () => {
  const app = await harness();
  const destination = path.resolve(__dirname, '../../docs/palette');
  await fs.mkdir(destination, {recursive: true});
  try {
    for (const [mode, label] of [['compact', 'compact'], ['expanded', 'balanced'], ['large', 'expanded']]) {
      const page = await app.page(mode);
      await page.emulateMedia({reducedMotion: 'reduce'});
      const canvas = await page.locator('.app').evaluate(el => getComputedStyle(el).backgroundColor);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
      const html = await fs.readFile(path.resolve(__dirname, '../../index.html'), 'utf8');
      const main = await fs.readFile(path.resolve(__dirname, '../../desktop/main.cjs'), 'utf8');
      const hex = '#' + rgb(canvas).map(v => v.toString(16).padStart(2, '0')).join('');
      assert.ok(html.toLowerCase().includes(`content="${hex}"`), 'Browser canvas differs from light theme');
      assert.ok(main.toLowerCase().includes(`backgroundcolor: '${hex}'`), 'Native startup canvas differs from light theme');
      for (const selector of ['.brand', '.shelf-subtitle', '.machine-main strong', '.machine-pill', '.machine-endpoint', '.route-tabs button.selected', '.footer-hint', '.density-picker select']) await check(page, selector);
      for (const selector of ['.machine-search', '.density-picker select']) await check(page, selector, 'border');
      await check(page, '.machine-search input', 'text', '::placeholder');
      await page.getByRole('button', {name: /^Select Studio,/}).focus();
      await check(page, '[data-host-id="host-0"] .machine-main', 'focus');
      await page.screenshot({path: path.join(destination, `after-${label}-transfers.png`)});
      await page.getByRole('button', {name: 'Clipboard', exact: true}).click();
      await page.locator('.clipboard-list [role="option"]').first().click();
      await page.waitForFunction(() => document.querySelector('.clipboard-action-primary .primary-button')?.disabled === false);
      await page.keyboard.press('Tab');
      await page.getByRole('listbox').focus();
      for (const selector of ['.clipboard-entry-copy > strong', '.clipboard-entry-copy > small', '.clipboard-entry-meta', '.clipboard-capture-state > span', '.clipboard-action-primary .primary-button', '.clipboard-filter-select']) await check(page, selector);
      await check(page, '.clipboard-search input', 'text', '::placeholder');
      await check(page, '.clipboard-search', 'border');
      await check(page, '.clipboard-list', 'focus');
      await page.screenshot({path: path.join(destination, `after-${label}-clipboard.png`)});
      {
        await page.locator('[data-host-id="host-0"]').hover();
        await page.getByRole('button', {name: 'Open site on Studio', exact: true}).click();
      }
      const input = page.locator('[data-host-id="host-0"] .quick-url-input');
      await input.fill('http://localhost:1331'); await input.focus();
      await check(page, '[data-host-id="host-0"] .quick-url-input');
      await check(page, '[data-host-id="host-0"] .quick-url-input', 'text', '::placeholder');
      await check(page, '[data-host-id="host-0"] .quick-url-input', 'border');
      await check(page, '[data-host-id="host-0"] .quick-url-input', 'focus');
      assert.deepEqual(page.errors, []);
      await page.close();
    }
    await fs.writeFile(path.join(destination, 'contrast.json'), JSON.stringify({scope: 'Representative rendered text, placeholders, input boundaries and focus states in all three densities; not a whole-app accessibility certification', checks: evidence}, null, 2) + '\n');
    console.log(`Light palette: ${evidence.length} rendered contrast checks passed; six fictional screenshots; native/browser startup backgrounds aligned.`);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
