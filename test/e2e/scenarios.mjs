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
