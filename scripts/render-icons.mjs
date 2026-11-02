// Render extension/icons/*.svg to the PNG sizes the manifest uses.
// Usage: node scripts/render-icons.mjs   (needs Playwright Chromium: npx playwright install chromium)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
const big = readFileSync(path.join(dir, 'icon.svg'), 'utf8');
const small = readFileSync(path.join(dir, 'icon-small.svg'), 'utf8');
// Small sizes use the simplified bolt-only glyph so it stays legible in the toolbar.
const jobs = [[16, small], [32, small], [48, big], [128, big]];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [size, svg] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.locator('svg').screenshot({ path: path.join(dir, `icon${size}.png`), omitBackground: true });
  console.log(`icon${size}.png`);
}
await browser.close();
