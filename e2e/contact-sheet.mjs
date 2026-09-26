// Tiles e2e screenshots into one image for quick visual review:
//   node e2e/contact-sheet.mjs [out.png] [pattern]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const dir = new URL('./artifacts/', import.meta.url).pathname;
const out = process.argv[2] || join(dir, 'contact-sheet.png');
const pattern = new RegExp(process.argv[3] || '^\\d\\d-.*\\.png$');
const files = readdirSync(dir)
  .filter((f) => pattern.test(f))
  .sort();
const cols = Math.min(5, files.length);
const w = 260;
const html = `<body style="margin:0;background:#222;font:12px sans-serif;color:#ccc">
<div style="display:grid;grid-template-columns:repeat(${cols},${w}px);gap:8px;padding:8px">
${files.map((f) => `<figure style="margin:0"><img src="data:image/png;base64,${readFileSync(join(dir, f)).toString('base64')}" style="width:${w}px;display:block"><figcaption>${f}</figcaption></figure>`).join('')}
</div></body>`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: cols * (w + 8) + 8, height: 400 } });
await page.setContent(html);
await page.waitForLoadState('load');
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log(out);
