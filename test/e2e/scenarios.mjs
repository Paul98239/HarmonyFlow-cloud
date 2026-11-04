// scenarios.mjs — 端到端情境。每個情境拿到 { page, url, out }，失敗就丟錯。

export async function boot(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('loading-overlay')?.classList.contains('is-dismissed'), null, { timeout: 90000 });
  await page.waitForFunction(() => !document.getElementById('app-shell').inert, null, { timeout: 5000 });
}

export async function loadLocal(page, out, name) {
  await page.setInputFiles('#localMidiInput', `${out}${name}.mid`);
  await page.waitForFunction(() => document.querySelectorAll('#scorePartList .score-part-id').length > 0, null, { timeout: 10000 });
}

export async function openSongPanel(page) {
  if (await page.locator('#panel-song').isHidden()) await page.click('#song-toggle');
}

export async function assignPart(page, index, value) {
  await openSongPanel(page);
  await page.locator('#scorePartList .score-part-id').nth(index).selectOption(String(value));
}

export async function closePanel(page) {
  if (await page.locator('#panel-song').isVisible()) await page.click('#panel-song .tl-close');
}

export async function play(page) {
  await page.waitForFunction(() => !document.getElementById('btnPlay').disabled, null, { timeout: 30000 });
  await page.click('#btnPlay');
  await page.waitForFunction(() => !document.getElementById('btnPause').disabled, null, { timeout: 60000 });
}

export async function setPoseCount(page, n) {
  await page.selectOption('#poseCountSelect', String(n));
}

const pressLog = (page) => page.evaluate(() => window.__pressLog().presses);

export const SCENARIOS = {
  // 開機、選本地檔、指派給 PC 鍵盤手、播放、按鍵：每一下都放行而且有聲音（noteOn 事件），沒有頁面錯誤
  async smokeKeyboard({ page, url, out }) {
    await boot(page, url);
    await loadLocal(page, out, 'duet');
    await assignPart(page, 0, 'kb');
    await closePanel(page);
    await play(page);
    await page.focus('body');
    for (let i = 0; i < 6; i++) { await page.keyboard.down('KeyF'); await page.waitForTimeout(250); await page.keyboard.up('KeyF'); await page.waitForTimeout(350); }
    const presses = await pressLog(page);
    const released = presses.filter((p) => p.released).length;
    if (released < 5) throw new Error(`按了 6 下只放行 ${released} 下：${JSON.stringify(presses)}`);
    const stats = await page.evaluate(() => window.__stats());
    if (stats.合奏.帶頭 !== 'kb') throw new Error(`帶頭的人不是 PC 鍵盤手：${JSON.stringify(stats.合奏)}`);
  },
};

SCENARIOS.modesUi = async ({ page, url, out }) => {
  await boot(page, url);
  await loadLocal(page, out, 'fastRuns');
  await assignPart(page, 0, 'kb');
  // 指派後模式下拉可用、預設「自動」；改成拍子
  const mode = page.locator('#scorePartList .score-part-mode').first();
  if (await mode.isDisabled()) throw new Error('指派之後模式下拉仍是 disabled');
  if ((await mode.inputValue()) !== 'auto') throw new Error(`預設模式不是自動：${await mode.inputValue()}`);
  await mode.selectOption('beat');
  if (await page.locator('#scorePartList .score-part-mode').nth(1).isEnabled()) throw new Error('沒指派的聲部，模式下拉應該是 disabled');
  await closePanel(page);
  await play(page);
  await page.focus('body');
  // 拍子模式：跟著拍子按（96 BPM，一拍 625ms），長笛的快音群也會由電腦補上
  for (let i = 0; i < 14; i++) { await page.keyboard.down(i % 2 ? 'KeyJ' : 'KeyF'); await page.waitForTimeout(120); await page.keyboard.up(i % 2 ? 'KeyJ' : 'KeyF'); await page.waitForTimeout(505); }
  await page.waitForFunction(() => !document.getElementById('performer-hud').hidden, null, { timeout: 3000 });
  const hud = await page.locator('#performer-hud').innerText();
  if (!/PC 鍵盤手/.test(hud) || !/拍子/.test(hud)) throw new Error(`狀態列內容不對：${hud}`);
  const v = await page.evaluate(() => window.__view());
  const kb = v.performers.find((p) => p.slot === 'kb');
  if (kb.mode !== 'beat') throw new Error(`排程器的模式是 ${kb.mode}`);
  if (kb.cursor < 30) throw new Error(`按了 14 拍只放到第 ${kb.cursor} 個音（快音群沒有被補上）`);
};

import { installFakePose } from './fakePose.mjs';

const humanVelocities = (page) => page.evaluate(() => window.__pressLog().events.filter((e) => e.type === 'noteOn' && e.kind === 'human').map((e) => e.velocity));

// 鍵盤的按鍵位置改變力度（真的頁面、真的合成器）
SCENARIOS.keyVelocity = async ({ page, url, out }) => {
  await boot(page, url);
  await loadLocal(page, out, 'duet');
  await assignPart(page, 0, 'kb');
  await closePanel(page);
  await play(page);
  await page.focus('body');
  const tap = async (key, n) => { for (let i = 0; i < n; i++) { await page.keyboard.down(key); await page.waitForTimeout(200); await page.keyboard.up(key); await page.waitForTimeout(250); } };
  await tap('KeyA', 4);
  const soft = await humanVelocities(page);
  await tap('Semicolon', 4);
  const all = await humanVelocities(page);
  const loud = all.slice(soft.length);
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!(avg(loud) > avg(soft) * 1.3)) throw new Error(`左邊 ${avg(soft).toFixed(0)}、右邊 ${avg(loud).toFixed(0)}`);
};

// 揮手（假的姿勢推論）：觸發、力道、表情（外接框）一路接到排程器，骨架與情緒框畫得出來
SCENARIOS.gestureExpression = async ({ page, url, out }) => {
  await installFakePose(page, [{ cx: 0.5, cy: 0.35, scale: 0.16, amp: 1.4, periodMs: 1250 }]);
  await boot(page, url);
  await setPoseCount(page, 1);
  await loadLocal(page, out, 'duet');
  await assignPart(page, 0, '1');
  await closePanel(page);
  await play(page);
  await page.waitForTimeout(7000);
  const presses = await page.evaluate(() => window.__pressLog().presses.filter((p) => p.slot === 1));
  if (presses.length < 4) throw new Error(`揮了 7 秒只有 ${presses.length} 下觸發`);
  const v = await page.evaluate(() => window.__view().performers.find((p) => p.slot === 1));
  if (v.expressionSource !== 'camera') throw new Error(`表情沒有從攝影機進來：${v.expressionSource}`);
  if (Math.abs(v.intensity - 0.5) < 0.01) throw new Error(`揮手的力道沒有進來：${v.intensity}`);
  const inked = await page.evaluate(() => {
    const c = document.getElementById('overlay-canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    return n;
  });
  if (inked < 500) throw new Error(`骨架／情緒框幾乎沒畫：${inked} 個像素`);
  // 改成小而慢：表情下降
  const before = v.expression;
  await page.evaluate(() => window.__fakePose.set([{ cx: 0.5, cy: 0.35, scale: 0.16, amp: 0.3, periodMs: 2200 }]));
  await page.waitForTimeout(8000);
  const after = await page.evaluate(() => window.__view().performers.find((p) => p.slot === 1).expression);
  if (!(after < before - 0.08)) throw new Error(`動作變小變慢，表情 ${before.toFixed(2)} → ${after.toFixed(2)}`);
};

// 任何 MIDI 都畫得出來：測資庫每一首（含 SMPTE、未量化、弱起、不規則小節、鼓）載入、指派、播放，樂譜面板每一條都有畫東西
SCENARIOS.scoreViewAllSongs = async ({ page, url, out }) => {
  await boot(page, url);
  const names = ['duet', 'fastRuns', 'pickup', 'irregular', 'unquantized', 'smpte', 'canonRests', 'quartet', 'pianoChords', 'drums', 'slowLong', 'solo'];
  for (const name of names) {
    await loadLocal(page, out, name);
    const nParts = await page.locator('#scorePartList .score-part-id').count();
    await assignPart(page, 0, 'kb');
    if (nParts > 1) { await setPoseCount(page, 1); await page.waitForTimeout(300); await assignPart(page, 1, '1'); }
    await closePanel(page);
    await play(page);
    await page.focus('body');
    for (let i = 0; i < 3; i++) { await page.keyboard.press('KeyF'); await page.waitForTimeout(300); }
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const c = document.getElementById('score-canvas'), ctx = c.getContext('2d');
      const lanes = Number(getComputedStyle(document.getElementById('score-panel')).getPropertyValue('--lanes'));
      const h = c.height / lanes, inked = [];
      for (let i = 0; i < lanes; i++) {
        const d = ctx.getImageData(0, Math.floor(i * h), c.width, Math.floor(h)).data;
        let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k]) n++;
        inked.push(n);
      }
      return { hidden: document.getElementById('score-panel').hidden, lanes, inked, chips: document.querySelectorAll('#performer-hud .hud-chip').length };
    });
    const expected = nParts > 1 ? 2 : 1;
    if (r.hidden || r.lanes !== expected || r.chips !== expected) throw new Error(`${name}：面板 ${JSON.stringify(r)}`);
    if (r.inked.some((n) => n < 2000)) throw new Error(`${name}：有一條幾乎沒畫 ${JSON.stringify(r.inked)}`);
    await page.click('#btnPause');
  }
  const stats = await page.evaluate(() => window.__scoreViewStats());
  if (!(stats.平均ms < 3)) throw new Error(`樂譜面板每幀平均 ${stats.平均ms}ms`);
};
