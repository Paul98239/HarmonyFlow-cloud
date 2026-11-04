// run.mjs — 端到端測試：無頭 Chromium 開真正的頁面（CDN 的合成器與 MediaPipe 照常載入，攝影機用 Chromium 的假裝置）。
// 用法：node test/e2e/run.mjs [情境名稱…]（不給就全部跑）。需要網路（CDN）。Playwright 用環境裡預裝的那份（require('playwright')），不加進相依。
// 姿勢推論：假攝影機畫面裡沒有人，所以預設的 Worker 照常跑（偵測不到人）；要模擬有人時，情境用 fakePoses() 把 poseWorker.js 換成假的 Worker，照腳本回傳骨架。

import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { buildMidi } from '../helpers/smf.js';
import { SONG_SPECS } from '../helpers/songs.js';
import { SCENARIOS } from './scenarios.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = fileURLToPath(new URL('./out/', import.meta.url));
mkdirSync(OUT, { recursive: true });
for (const name of Object.keys(SONG_SPECS)) writeFileSync(`${OUT}${name}.mid`, buildMidi(SONG_SPECS[name]()));

const { server, url } = await startServer();
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
});
const only = process.argv.slice(2);
let failed = 0;
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (only.length && !only.includes(name)) continue;
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, permissions: ['camera'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const t0 = Date.now();
  try {
    await scenario({ page, url, out: OUT, errors });
    const real = errors.filter((e) => !/favicon|imuse\.ncnu|Midi-library|net::ERR|Failed to load resource|搜尋 MIDI 歌曲清單失敗|CORS/.test(e));
    if (real.length) throw new Error(`頁面錯誤：\n  ${real.join('\n  ')}`);
    console.log(`ok   ${name}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}：${err.message}`);
    await page.screenshot({ path: `${OUT}${name}-fail.png` }).catch(() => {});
  }
  await context.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
