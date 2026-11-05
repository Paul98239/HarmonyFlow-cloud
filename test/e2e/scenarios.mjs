// scenarios.mjs — 端到端情境。每個情境拿到 { page, url, out }，失敗就丟錯。

export async function boot(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('loading-overlay')?.classList.contains('is-dismissed'), null, { timeout: 90000 });
  await page.waitForFunction(() => !document.getElementById('app-shell').inert, null, { timeout: 5000 });
}

export async function loadLocal(page, out, name) {
  await page.setInputFiles('#localMidiInput', `${out}${name}.mid`);
  // 等到換成這首歌（歌名）而且分譜清單畫好：只等清單有東西的話，換第二首時會讀到上一首還沒換掉的清單
  await page.waitForFunction((file) => document.getElementById('midiStatusText').textContent.includes(file)
    && document.querySelectorAll('#scorePartList .score-part-id').length > 0, `${name}.mid`, { timeout: 10000 });
  await page.waitForTimeout(100);
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

// ─── 階段 4：上場防呆 ───
const mulberry = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const enabled = (page, sel) => page.locator(sel).isEnabled();
const WAVER = (cx) => ({ cx, cy: 0.35, scale: 0.15, amp: 1.2, periodMs: 1250 });

// 選歌、指派、現場人數、開鏡頭、播放……的順序怎麼打亂都不會卡住：每一步之後「有歌又沒在處理」時播放或暫停至少一個能按；最後一定能播
async function randomOrder(page, url, out, seed) {
  await installFakePose(page, [WAVER(0.4)]);
  await boot(page, url);
  const r = mulberry(seed), pick = (xs) => xs[Math.floor(r() * xs.length)];
  const songs = ['duet', 'quartet', 'canonRests', 'solo', 'smpte', 'pickup'];
  let loaded = false, log = [];
  const parts = () => page.locator('#scorePartList .score-part-id').count();
  const ops = {
    song: async () => { await loadLocal(page, out, pick(songs)); loaded = true; },
    assignKb: async () => { const n = await parts(); if (n) await assignPart(page, Math.floor(r() * n), 'kb'); },
    assignId: async () => { const n = await parts(); const c = Number(await page.locator('#poseCountSelect').inputValue()) || 0; if (n && c) await assignPart(page, Math.floor(r() * n), String(1 + Math.floor(r() * c))); },
    unassign: async () => { const n = await parts(); if (n) await assignPart(page, Math.floor(r() * n), ''); },
    mode: async () => { await openSongPanel(page); const m = page.locator('#scorePartList .score-part-mode:not([disabled])'); if (await m.count()) await m.first().selectOption(pick(['auto', 'musician', 'onset', 'beat'])); },
    count: async () => { await setPoseCount(page, 1 + Math.floor(r() * 4)); await page.waitForTimeout(200); },
    camera: async () => { await page.waitForFunction(() => !document.getElementById('btn-camera-toggle').disabled); await page.click('#btn-camera-toggle'); await page.waitForTimeout(400); },
    play: async () => { if (await enabled(page, '#btnPlay')) { await page.click('#btnPlay'); await page.waitForTimeout(500); } },
    pause: async () => { if (await enabled(page, '#btnPause')) await page.click('#btnPause'); },
    replay: async () => { if (await enabled(page, '#btnReplay')) { await page.click('#btnReplay'); await page.waitForTimeout(400); } },
    keys: async () => { await closePanel(page); await page.focus('body'); for (const k of ['KeyF', 'KeyJ', 'KeyF']) { await page.keyboard.press(k); await page.waitForTimeout(250); } },
    people: async () => { await page.evaluate((p) => window.__fakePose.set(p), pick([[], [WAVER(0.4)], [WAVER(0.3), WAVER(0.7)]])); },
    reset: async () => { await page.click('#btn-reset-pose'); },
    preview: async () => { if (await enabled(page, '#btnPreview')) { await page.click('#btnPreview'); await page.waitForTimeout(600); } },
  };
  const names = Object.keys(ops);
  for (let i = 0; i < 16; i++) {
    const op = i === 3 && !loaded ? 'song' : pick(names);
    log.push(op);
    await ops[op]();
    const st = await page.evaluate(() => ({ busy: document.getElementById('toolbar-playback').classList.contains('is-empty'), play: !document.getElementById('btnPlay').disabled, pause: !document.getElementById('btnPause').disabled, loading: document.getElementById('btnPlay').classList.contains('is-loading') }));
    if (loaded && !st.busy && !st.loading && !st.play && !st.pause) {
      await page.waitForTimeout(1500);   // 處理中（載入、續播）最多等一下
      const again = await page.evaluate(() => !document.getElementById('btnPlay').disabled || !document.getElementById('btnPause').disabled);
      if (!again) throw new Error(`種子 ${seed}：卡住了（播放與暫停都不能按），步驟：${log.join(' → ')}`);
    }
  }
  // 最後：一定能播。離開試聽、確定有歌、指派給 PC 鍵盤手，按播放、按鍵要能放行
  if (await page.locator('#btnPreview').evaluate((b) => b.classList.contains('is-current'))) await page.click('#btnPreview');
  if (!loaded) await loadLocal(page, out, 'duet');
  await assignPart(page, 0, 'kb');
  await closePanel(page);
  if (await enabled(page, '#btnPlay')) await page.click('#btnPlay');
  await page.waitForFunction(() => !document.getElementById('btnPause').disabled, null, { timeout: 15000 }).catch(() => { throw new Error(`種子 ${seed}：最後按不了播放，步驟：${log.join(' → ')}`); });
  await page.focus('body');
  const before = (await page.evaluate(() => window.__pressLog().presses.filter((p) => p.released).length));
  for (let i = 0; i < 5; i++) { await page.keyboard.press(i % 2 ? 'KeyJ' : 'KeyF'); await page.waitForTimeout(350); }
  const after = await page.evaluate(() => window.__pressLog().presses.filter((p) => p.released || p.result === 'beat').length);
  const fin = await page.evaluate(() => document.getElementById('btnPlay').disabled === false && document.getElementById('btnPause').disabled);
  if (after <= before && !fin) throw new Error(`種子 ${seed}：最後按鍵都沒有放行，步驟：${log.join(' → ')}`);
}
// 預設 6 組種子；RANDOM_SEEDS=30 node test/e2e/run.mjs 可以多跑（種子 1000 起）
const extraSeeds = Number(process.env.RANDOM_SEEDS || 0);
for (const seed of [11, 22, 33, 44, 55, 66, ...Array.from({ length: extraSeeds }, (_, i) => 1000 + i)]) SCENARIOS[`randomOrder${seed}`] = ({ page, url, out }) => randomOrder(page, url, out, seed);

// 演奏者一直沒被偵測到：舞台中央請他面向鏡頭；背對鏡頭（看不到臉）也不會被鎖定；轉過來就消失、可以演奏
SCENARIOS.faceTheCamera = async ({ page, url, out }) => {
  await installFakePose(page, [{ ...WAVER(0.5), faceVisible: false }]);
  await boot(page, url);
  await setPoseCount(page, 1);
  await loadLocal(page, out, 'duet');
  await assignPart(page, 0, '1');
  await closePanel(page);
  await page.waitForTimeout(3000);
  const hint = await page.locator('#stage-hint').innerText();
  if (!/演奏者 1/.test(hint) || !/面向鏡頭/.test(hint)) throw new Error(`沒有請他面向鏡頭：「${hint}」`);
  await play(page);
  await page.waitForTimeout(2500);
  const hud = await page.locator('#performer-hud').innerText();
  if (!/請面向鏡頭/.test(hud)) throw new Error(`狀態列沒有提示：${hud}`);
  if ((await page.evaluate(() => window.__pressLog().presses.length)) > 0) throw new Error('背對鏡頭（看不到臉）卻被鎖定、觸發了');
  await page.evaluate((p) => window.__fakePose.set(p), [WAVER(0.5)]);
  await page.waitForTimeout(5000);
  if (!(await page.locator('#stage-hint').isHidden())) throw new Error(`轉過來之後提示還在：${await page.locator('#stage-hint').innerText()}`);
  const n = await page.evaluate(() => window.__pressLog().presses.filter((p) => p.slot === 1).length);
  if (n < 2) throw new Error(`轉過來之後揮了 5 秒只觸發 ${n} 下`);
};

// 現場人數選 3、只有 1 個人：多出來的 ID 標成「未偵測到」；指派給沒出現的 ID 的聲部不擋別人，在場的人照樣演奏
SCENARIOS.ghostIds = async ({ page, url, out }) => {
  await installFakePose(page, [WAVER(0.5)]);
  await boot(page, url);
  await setPoseCount(page, 3);
  await loadLocal(page, out, 'canonRests');
  await page.waitForTimeout(1500);
  await openSongPanel(page);
  const labels = await page.locator('#scorePartList .score-part-id').first().locator('option').allInnerTexts();
  if (!labels.some((t) => t === '演奏者 1') || !labels.some((t) => /演奏者 2（未偵測到）/.test(t)) || !labels.some((t) => /演奏者 3（未偵測到）/.test(t))) throw new Error(`下拉沒有標出沒出現的 ID：${labels}`);
  await assignPart(page, 0, '3');   // 先進場的大提琴給沒有人的 ID 3
  await assignPart(page, 1, '1');
  await closePanel(page);
  await play(page);
  await page.waitForTimeout(12000);
  const v = await page.evaluate(() => window.__view());
  const p1 = v.performers.find((p) => p.slot === 1), p3 = v.performers.find((p) => p.slot === 3);
  if (!(p1.cursor > 3)) throw new Error(`在場的演奏者 1 沒有在演奏：${JSON.stringify(p1)}`);
  if (p3.state !== 'substitute') throw new Error(`沒有人的 ID 3 應該由電腦代打：${p3.state}`);
};

// 黑幕上的版面：骨架（含揮到最低的手）畫在頂端工具列與樂譜面板之間，不被面板蓋住、也不鑽到工具列底下
SCENARIOS.skeletonClearOfPanel = async ({ page, url, out }) => {
  await installFakePose(page, [{ cx: 0.35, cy: 0.33, scale: 0.17, amp: 1.6, periodMs: 1000 }, { cx: 0.66, cy: 0.36, scale: 0.15, amp: 1.4, periodMs: 1300 }]);
  await boot(page, url);
  await setPoseCount(page, 2);
  await loadLocal(page, out, 'quartet');
  for (const [i, v] of [[0, '1'], [1, '2'], [2, 'kb'], [3, 'kb']]) await assignPart(page, i, v);
  await closePanel(page);
  await play(page);
  await page.waitForTimeout(2500);
  for (let n = 0; n < 6; n++) {
    await page.waitForTimeout(170);
    const r = await page.evaluate(() => {
      const c = document.getElementById('overlay-canvas'), box = c.getBoundingClientRect();
      const s = Math.max(box.width / c.width, box.height / c.height), offY = (box.height - c.height * s) / 2;
      const row = (y) => Math.round((y - box.top - offY) / s);
      const panelTop = row(document.getElementById('score-panel').getBoundingClientRect().top);
      const toolBottom = row(document.getElementById('top-center-stack').getBoundingClientRect().bottom);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let below = 0, above = 0, total = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        if (!d[(y * c.width + x) * 4 + 3]) continue;
        total++;
        if (y >= panelTop) below++;
        if (y < toolBottom - 2) above++;
      }
      return { below, above, total, panelTop, toolBottom };
    });
    if (r.total < 500) throw new Error(`骨架幾乎沒畫：${JSON.stringify(r)}`);
    if (r.below > 0) throw new Error(`骨架畫到樂譜面板底下：${JSON.stringify(r)}`);
    // ID 標籤可能貼著工具列下緣；只允許極少量的標籤描邊
    if (r.above > 50) throw new Error(`骨架鑽到頂端工具列底下：${JSON.stringify(r)}`);
  }
  // 演奏中播放 pill 淡下來（滑鼠移開之後），滑鼠移回來全亮
  await page.mouse.move(640, 400);
  await page.waitForTimeout(500);
  const dim = await page.evaluate(() => Number(getComputedStyle(document.getElementById('toolbar-playback')).opacity));
  if (!(dim < 0.8)) throw new Error(`演奏中播放 pill 沒有淡下來：${dim}`);
  await page.hover('#btnPause');
  await page.waitForTimeout(500);
  const lit = await page.evaluate(() => Number(getComputedStyle(document.getElementById('toolbar-playback')).opacity));
  if (!(lit > 0.95)) throw new Error(`滑鼠移到播放 pill 上沒有全亮：${lit}`);
};

// 五人（PC 鍵盤手＋4 個揮手的人）：五條樂譜、五格狀態，四個人都在觸發，鍵盤手也能演奏
SCENARIOS.fivePerformers = async ({ page, url, out }) => {
  await installFakePose(page, [0.2, 0.4, 0.6, 0.8].map((cx, i) => ({ cx, cy: 0.36, scale: 0.11, amp: 1.2, periodMs: 1100 + 120 * i, phaseMs: i * 180 })));
  await boot(page, url);
  await setPoseCount(page, 4);
  await loadLocal(page, out, 'quintet');
  await page.waitForTimeout(800);
  for (const [i, v] of [[0, 'kb'], [1, '1'], [2, '2'], [3, '3'], [4, '4']]) await assignPart(page, i, v);
  await closePanel(page);
  await play(page);
  await page.focus('body');
  for (let i = 0; i < 8; i++) { await page.keyboard.press(i % 2 ? 'KeyJ' : 'KeyF'); await page.waitForTimeout(300); }
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({
    lanes: Number(getComputedStyle(document.getElementById('score-panel')).getPropertyValue('--lanes')),
    chips: document.querySelectorAll('#performer-hud .hud-chip').length,
    bySlot: window.__pressLog().presses.reduce((m, p) => { m[p.slot] = (m[p.slot] || 0) + 1; return m; }, {}),
  }));
  if (r.lanes !== 5 || r.chips !== 5) throw new Error(`五人應該有五條：${JSON.stringify(r)}`);
  for (const s of ['kb', 1, 2, 3, 4]) if (!(r.bySlot[s] >= 2)) throw new Error(`${s} 沒有在觸發：${JSON.stringify(r.bySlot)}`);
  await page.mouse.move(640, 300);
  await page.screenshot({ path: `${out}fivePerformers.png` });
};

// 外部中斷與意外錯誤（防呆）：切到別的分頁、聲音被系統暫停、排程 tick 連續出錯——演奏都先暫停、頂端寫原因，按 ▶ 從原處繼續
SCENARIOS.interruptions = async ({ page, url, out, errors }) => {
  // 記下頁面建的 AudioContext，模擬「系統把聲音暫停」（換耳機、來電）用
  await page.addInitScript(() => {
    const Orig = window.AudioContext;
    window.AudioContext = class extends Orig { constructor(...a) { super(...a); window.__testAudioCtx = this; } };
  });
  await boot(page, url);
  await loadLocal(page, out, 'duet');
  await assignPart(page, 0, 'kb');
  await closePanel(page);
  await play(page);
  const notice = () => page.locator('#midiStatusText').innerText();
  const pausedWith = async (re, what) => {
    await page.waitForFunction(() => !document.getElementById('btnPlay').disabled, null, { timeout: 3000 }).catch(() => { throw new Error(`${what}：沒有暫停`); });
    const t = await notice();
    if (!re.test(t)) throw new Error(`${what}：頂端寫的是「${t}」`);
  };
  const pos = () => page.evaluate(() => window.__view().positionTicks);

  // 1. 切到別的分頁
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  });
  await pausedWith(/切到別的畫面/, '切到別的分頁');
  await play(page);

  // 2. 聲音被系統暫停
  await page.evaluate(() => window.__testAudioCtx.suspend());
  await pausedWith(/聲音被系統暫停/, '聲音被暫停');
  await play(page);
  const state = await page.evaluate(() => window.__testAudioCtx.state);
  if (state !== 'running') throw new Error(`按 ▶ 之後 AudioContext 是 ${state}`);

  // 3. 排程 tick 一直出錯：暫停、記進 __faults()；修好之後按 ▶ 從原處繼續、按鍵照常放行
  const before = await pos();
  await page.evaluate(async () => {
    const synth = await import('/src/midi/synth.js');
    const tick = synth.scheduler.tick;
    synth.scheduler.tick = () => { throw new Error('測試：排程 tick 出錯'); };
    window.__restoreTick = () => { synth.scheduler.tick = tick; };
  });
  await pausedWith(/出了點狀況/, '排程出錯');
  const faults = await page.evaluate(() => window.__faults());
  if (!faults.some((f) => f.where === 'tick')) throw new Error(`__faults() 沒有記到：${JSON.stringify(faults)}`);
  errors.splice(0, errors.length, ...errors.filter((e) => !/測試：排程 tick 出錯/.test(e)));
  await page.evaluate(() => window.__restoreTick());
  await play(page);
  await page.focus('body');
  for (let i = 0; i < 3; i++) { await page.keyboard.down('KeyF'); await page.waitForTimeout(200); await page.keyboard.up('KeyF'); await page.waitForTimeout(300); }
  if (!((await pos()) >= before)) throw new Error('繼續之後位置倒退了');
  const released = (await pressLog(page)).filter((p) => p.released).length;
  if (released < 3) throw new Error(`繼續之後按鍵沒放行（放行 ${released} 下）`);
};

// 背景的樂器：五人各一件（五種畫法），照他實際發出的音動作——鍵盤手按住鍵時，他的樂器亮著的音高＝排程器正在響的他的音；放開後熄掉
SCENARIOS.stageInstruments = async ({ page, url, out }) => {
  await installFakePose(page, [0.2, 0.4, 0.6, 0.8].map((cx, i) => ({ cx, cy: 0.36, scale: 0.11, amp: 1.2, periodMs: 1100 + 120 * i, phaseMs: i * 180 })));
  await boot(page, url);
  await setPoseCount(page, 4);
  await loadLocal(page, out, 'quintet');
  await page.waitForTimeout(800);
  for (const [i, v] of [[0, 'kb'], [1, '1'], [2, '2'], [3, '3'], [4, '4']]) await assignPart(page, i, v);
  await closePanel(page);
  await play(page);
  await page.focus('body');
  const kbSounding = () => page.evaluate(async () => {
    const synth = await import('/src/midi/synth.js');
    const ids = new Set(synth.scheduler.inspect().staves.filter((s) => s.slot === 'kb' && s.kind === 'human').map((s) => s.id));
    const sched = synth.scheduler.inspect().staves.filter((s) => ids.has(s.id)).flatMap((s) => s.sounding.map((e) => e.pitch)).sort((a, b) => a - b);
    const inst = window.__instruments().find((i) => i.slot === 'kb');
    return { sched, inst: inst?.sounding ?? null, all: window.__instruments().map((i) => `${i.slot}:${i.kind}`) };
  });
  let matched = 0;
  for (let i = 0; i < 6; i++) {
    const key = i % 2 ? 'KeyJ' : 'KeyF';
    await page.keyboard.down(key);
    await page.waitForTimeout(160);
    const r = await kbSounding();
    if (r.all.length !== 5) throw new Error(`應該有五件樂器：${JSON.stringify(r.all)}`);
    if (r.sched.length && JSON.stringify(r.sched) === JSON.stringify(r.inst)) matched++;
    else if (r.sched.length) throw new Error(`按住時樂器亮的音高跟正在響的音不一樣：${JSON.stringify(r)}`);
    await page.keyboard.up(key);
    await page.waitForTimeout(260);
  }
  if (matched < 3) throw new Error(`按了 6 下只有 ${matched} 下對得上`);
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => window.__instrumentStats());
  if (!(st.幀數 > 10)) throw new Error(`背景樂器幾乎沒畫：${JSON.stringify(st)}`);
  if (!(st.平均ms < 4)) throw new Error(`背景樂器每幀太花時間：${JSON.stringify(st)}`);
  // 樂器畫在舞台上（不透明的像素夠多），而且在樂譜面板上方
  const px = await page.evaluate(() => {
    const c = document.getElementById('instrument-canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const panelTop = (document.getElementById('score-panel').getBoundingClientRect().top - c.getBoundingClientRect().top) * (c.height / c.getBoundingClientRect().height);
    let n = 0, below = 0;
    for (let y = 0; y < c.height; y += 3) for (let x = 0; x < c.width; x += 3) if (d[(y * c.width + x) * 4 + 3] > 20) { n++; if (y > panelTop + 2) below++; }
    return { n, below };
  });
  if (px.n < 400) throw new Error(`背景樂器幾乎看不到：${JSON.stringify(px)}`);
  if (px.below > 0) throw new Error(`背景樂器畫到樂譜面板底下：${JSON.stringify(px)}`);
  await page.mouse.move(640, 300);
  await page.screenshot({ path: `${out}stageInstruments.png` });
};

// 效能預算（五人演奏中）：主執行緒沒有長任務堆積、排程 tick 幾乎都在 lookahead（50ms）之內——tick 晚了，電腦的音就來不及提早帶時間戳送出（會晚）。
// 之前每幀在主執行緒 createImageBitmap(<video>)、把看不到的攝影機畫面上傳成 WebGL 貼圖，這裡會失敗
SCENARIOS.perfBudget = async ({ page, url, out }) => {
  await installFakePose(page, [0.2, 0.4, 0.6, 0.8].map((cx, i) => ({ cx, cy: 0.36, scale: 0.11, amp: 1.2, periodMs: 1100 + 120 * i, phaseMs: i * 180 })));
  await boot(page, url);
  await setPoseCount(page, 4);
  await loadLocal(page, out, 'quintet');
  await page.waitForTimeout(800);
  for (const [i, v] of [[0, 'kb'], [1, '1'], [2, '2'], [3, '3'], [4, '4']]) await assignPart(page, i, v);
  await closePanel(page);
  await play(page);
  await page.focus('body');
  for (let i = 0; i < 20; i++) { await page.keyboard.press(i % 2 ? 'KeyJ' : 'KeyF'); await page.waitForTimeout(350); }
  const r = await page.evaluate(() => {
    const l = window.__latency(), k = Object.keys(l).find((x) => x.startsWith('現場人數'));
    return k && { long: l[k].長任務, tick: l[k].排程tick間隔ms, main: l[k]['主執行緒佔比%'] };
  });
  if (!r) throw new Error('沒有量到演奏中的數字');
  const late = r.tick['超過50ms'] ?? 0;
  if (r.long && r.long.總ms > 250) throw new Error(`長任務太多：${JSON.stringify(r.long)}`);
  if (late > Math.max(3, r.tick.count * 0.05)) throw new Error(`排程 tick 常常晚過 lookahead：${JSON.stringify(r.tick)}`);
};

// 演奏時的舒適：滑鼠沒動一陣子游標藏起來、一動就出現；全螢幕鈕切得進去也切得出來（不支援的瀏覽器不顯示）；播放中要求螢幕不休眠不會出錯
SCENARIOS.comfort = async ({ page, url, out }) => {
  await boot(page, url);
  await loadLocal(page, out, 'duet');
  await assignPart(page, 0, 'kb');
  await closePanel(page);
  await play(page);
  await page.mouse.move(600, 400);
  await page.waitForTimeout(3000);
  if (!(await page.evaluate(() => document.body.classList.contains('cursor-idle')))) throw new Error('播放中滑鼠沒動，游標沒有藏起來');
  await page.mouse.move(620, 420);
  if (await page.evaluate(() => document.body.classList.contains('cursor-idle'))) throw new Error('滑鼠動了游標沒有出現');
  const btn = page.locator('#btn-fullscreen');
  if (await btn.isHidden()) return;   // 這個瀏覽器不支援全螢幕
  await page.hover('#control-row').catch(() => {});
  await btn.click();
  await page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 3000 });
  if ((await btn.getAttribute('aria-label')) !== '離開全螢幕') throw new Error('全螢幕之後按鈕沒有變成「離開全螢幕」');
  await btn.click();
  await page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 3000 });
};

// 很密、很大聲的歌（12 聲部、三和弦、力度 127）：輸出不超過 1.0（不爆音）。沒有軟削波時峰值實測 1.67、九成的時間都在削波
SCENARIOS.noClipping = async ({ page, url, out }) => {
  const { buildMidi } = await import('../helpers/smf.js');
  const { writeFileSync } = await import('node:fs');
  const ppq = 480, parts = [];
  for (let p = 0; p < 12; p++) {
    const notes = [];
    for (let t = 0; t < 32 * ppq; t += ppq / 2) for (let c = 0; c < 3; c++) notes.push({ tick: t, dur: ppq / 2, pitch: 36 + p * 4 + c * 4, vel: 127 });
    parts.push(p === 9 ? { channel: 9, notes: notes.map((n) => ({ ...n, pitch: 36 + (n.pitch % 12) })) } : { program: [0, 48, 56, 61, 33, 40, 73, 24, 19, 0, 52, 89][p], notes });
  }
  writeFileSync(`${out}loud.mid`, buildMidi({ ppq, tempos: [{ tick: 0, bpm: 120 }], timeSigs: [{ tick: 0, num: 4, den: 4 }], parts }));
  await page.addInitScript(() => {
    // 輸出路徑上不能有 DynamicsCompressor（固定 6ms 的預看延遲，每一顆音都晚）
    const mk = BaseAudioContext.prototype.createDynamicsCompressor;
    window.__compressors = 0;
    BaseAudioContext.prototype.createDynamicsCompressor = function (...a) { window.__compressors++; return mk.apply(this, a); };
    const orig = AudioNode.prototype.connect;
    window.__peak = { max: 0, over: 0, frames: 0 };
    AudioNode.prototype.connect = function (dest, ...rest) {
      const r = orig.call(this, dest, ...rest);
      if (dest instanceof AudioDestinationNode && !this.__tapped) {
        this.__tapped = true;
        const an = this.context.createAnalyser(); an.fftSize = 2048; orig.call(this, an);
        const buf = new Float32Array(an.fftSize);
        setInterval(() => { an.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); window.__peak.frames++; window.__peak.max = Math.max(window.__peak.max, m); if (m > 1) window.__peak.over++; }, 40);
      }
      return r;
    };
  });
  await boot(page, url);
  await loadLocal(page, out, 'loud');
  await assignPart(page, 0, 'kb');
  await closePanel(page);
  await play(page);
  await page.focus('body');
  for (let i = 0; i < 16; i++) { await page.keyboard.down('Semicolon'); await page.waitForTimeout(150); await page.keyboard.up('Semicolon'); await page.waitForTimeout(150); }
  const p = await page.evaluate(() => window.__peak);
  if (p.frames < 20) throw new Error(`沒量到輸出：${JSON.stringify(p)}`);
  if (p.over > 0 || p.max > 1) throw new Error(`輸出削波（爆音）：${JSON.stringify(p)}`);
  if (p.max < 0.5) throw new Error(`輸出太小聲：${JSON.stringify(p)}`);
  // 播放前預先載入了這首歌的音色（第一下不會因為合成器在解壓縮 sample 而爆音、變晚）；上面的音量檢查也確認了之後有把輸出打開
  const pre = await page.evaluate(() => window.__stats().預先載入音色);
  if (!(pre?.probes > 0)) throw new Error(`播放前沒有預先載入音色：${JSON.stringify(pre)}`);
  const comps = await page.evaluate(() => window.__compressors);
  if (comps) throw new Error(`輸出路徑上建了 ${comps} 個 DynamicsCompressor（每顆音晚 6ms）`);
};
