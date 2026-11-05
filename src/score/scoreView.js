// scoreView.js — 樂譜視覺化（index.html 的 #score-panel／#score-canvas）：每位演奏者一條（他的顏色），他自己的音從右邊往「現在」那條線流過來，
// 下一下會放出的音框起來、頭上一顆大圓點（拍子模式是下一拍的拍線）；放過的音變暗；落後時圓點閃橘色、代打中整條泛紅、休息中泛藍。左邊的文字是 performerHud.js。
//
// 任何 MIDI 都能畫：每條的音在載入時排好（scheduler.js 的 scoreView()，依起音排序），每一幀只用二分搜尋找畫面內的那一段；音高範圍依這個聲部自己的最低到最高音縮放；
// 打擊、和弦、很密的快音都只是長方形。主執行緒負擔：一張 canvas、最多 30fps、只在演奏中畫、不用陰影與濾鏡；每幀的耗時記在 stats（__scoreViewStats()）。

import { slotColor, hexRgb, rgba } from './palette.js';
import { lowerBound } from '../midi/search.js';
import { setReservedBottom, setReservedTop } from './layout.js';

const FPS = 30;
const PAST_SEC = 0.8;        // 「現在」線左邊顯示多久之前（真實秒）
const FUTURE_SEC = 5;        // 右邊顯示多久之後（真實秒）
const NOW_X = 0.14;          // 「現在」線在寬度的哪裡

// 每條的資料依槽位查：只在 scoreView() 的結果換了（載入、改指派）時重建
let bySlotFor = null, bySlot = null;
const lanesBySlot = (stat) => {
  if (bySlotFor !== stat) { bySlotFor = stat; bySlot = new Map(stat.lanes.map((l) => [l.slot, l])); }
  return bySlot;
};

export const stats = { frames: 0, totalMs: 0, maxMs: 0, reset() { this.frames = 0; this.totalMs = 0; this.maxMs = 0; } };

/**
 * @param {{ getView: () => object, getStatic: () => object|null, isActive: () => boolean }} deps
 *   getView＝scheduler.viewState()、getStatic＝scheduler.scoreView()、isActive＝要不要顯示（演奏中或暫停中）
 */
export function startScoreView({ getView, getStatic, isActive }) {
  const panel = document.getElementById('score-panel');
  const canvas = document.getElementById('score-canvas');
  if (!panel || !canvas) return;
  const ctx = canvas.getContext('2d');
  let lastDraw = 0, lanesShown = -1, size = { w: 0, h: 0, dpr: 1 };

  // 面板佔掉舞台底部多少（vision.js 把骨架縮到它上方）：顯示、隱藏、改變大小時量一次，不在每幀量
  const stage = document.getElementById('stage');
  // 頂端工具列也一樣量（它是 position:fixed、疊在舞台上緣），骨架縮到兩者之間
  const topStack = document.getElementById('top-center-stack');
  const publishReserved = () => {
    if (!stage) return;
    const sr = stage.getBoundingClientRect();
    if (!(sr.height > 0)) return;
    const tr = topStack?.getBoundingClientRect();
    setReservedTop(tr ? (tr.bottom - sr.top) / sr.height + 0.01 : 0);
    if (panel.hidden) { setReservedBottom(0); return; }
    const pr = panel.getBoundingClientRect();
    setReservedBottom((sr.bottom - pr.top) / sr.height + 0.02);
  };
  // 舞台變大小、工具列變高（長歌名換行、系統提示出現）、面板變高都要重量
  if (stage) { const ro = new ResizeObserver(publishReserved); ro.observe(stage); if (topStack) ro.observe(topStack); ro.observe(panel); }
  publishReserved();
  const resize = () => {
    publishReserved();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; }
    size = { w, h, dpr };
  };
  new ResizeObserver(resize).observe(canvas);

  const frame = (now) => {
    requestAnimationFrame(frame);
    if (now - lastDraw < 1000 / FPS - 2) return;
    lastDraw = now;
    let view = null, stat = null;
    const active = isActive();
    if (active) { try { view = getView(); stat = getStatic(); } catch { view = null; } }
    const n = view?.performers.length ?? 0;
    const show = active && n > 0 && !!stat;
    if (panel.hidden === show) { panel.hidden = !show; publishReserved(); }
    if (!show) return;
    // 四條以上時每格只放得下兩行：面板切成緊湊版（CSS 的 .score-panel.is-dense）
    if (n !== lanesShown) { lanesShown = n; panel.style.setProperty('--lanes', String(n)); panel.classList.toggle('is-dense', n >= 4); resize(); }
    const t0 = performance.now();
    draw(ctx, size, view, stat, now);
    const ms = performance.now() - t0;
    stats.frames++; stats.totalMs += ms; if (ms > stats.maxMs) stats.maxMs = ms;
  };
  requestAnimationFrame(frame);
}

function draw(ctx, { w: W, h: H, dpr }, view, stat, nowMs) {
  ctx.clearRect(0, 0, W, H);
  const lanes = view.performers, n = lanes.length, laneH = H / n;
  const rate = view.rate > 0 ? view.rate : 1, pos = view.positionSec;
  const nowX = Math.round(W * NOW_X), pxPerScoreSec = (W - nowX) / (FUTURE_SEC * rate);
  const xOf = (sec) => nowX + (sec - pos) * pxPerScoreSec;
  const visLo = pos - PAST_SEC * rate, visHi = pos + FUTURE_SEC * rate;
  const byslot = lanesBySlot(stat);
  const pulse = 0.5 + 0.5 * Math.sin(nowMs / 140);
  for (let i = 0; i < n; i++) {
    const v = lanes[i], L = byslot.get(v.slot);
    if (!L) continue;
    const rgb = hexRgb(slotColor(v.slot));
    const y0 = Math.round(i * laneH) + 2 * dpr, lh = Math.round(laneH) - 4 * dpr;
    if (lh < 8 * dpr) continue;   // 版面還沒量好（剛顯示、還沒 resize）時條高可能是 0 或負的
    // 底色：代打中泛紅、落後泛橘、休息／等待泛藍
    // 底色：舞台是黑幕，半透明黑等於沒畫，所以用他自己顏色的淡底色；代打中泛紅、落後泛橘、休息／等待泛藍（都比正常亮，一眼看得出來）
    // 休息／等待用中性灰（藍色在長輩眼裡容易顯得褪色、看不出來）
    ctx.fillStyle = v.state === 'substitute' ? 'rgba(200,50,50,0.32)' : v.state === 'behind' ? 'rgba(230,140,20,0.3)' : v.state === 'resting' || v.state === 'waiting' ? 'rgba(140,140,150,0.18)' : rgba(rgb, 0.1);
    ctx.fillRect(0, y0, W, lh);
    ctx.strokeStyle = rgba(rgb, v.isLeader ? 1 : 0.7);
    ctx.lineWidth = (v.isLeader ? 3 : 1.5) * dpr;
    ctx.strokeRect(0.5, y0 + 0.5, W - 1, lh - 1);
    // 拍線只畫給拍子模式的人（他照拍子揮）；其他模式看音就好，多一排線只是雜訊
    const beats = stat.beatSec;
    if (v.mode === 'beat') {
      ctx.fillStyle = rgba(rgb, 0.45);
      for (let b = lowerBound(beats, visLo); b < beats.length && beats[b] <= visHi; b++) ctx.fillRect(Math.round(xOf(beats[b])), y0, Math.max(1, dpr), lh);
    }
    // 音：音高縮放到這條的高度
    const pad = 5 * dpr, inner = lh - 2 * pad, range = Math.max(6, L.hi - L.lo);
    const barH = Math.max(3 * dpr, Math.min(12 * dpr, inner / (range + 1)));
    const yOf = (p) => y0 + pad + (1 - (p - L.lo) / range) * (inner - barH);
    const from = v.next.from, to = v.next.to;
    // 第一個可能看得到的音：起音在 visLo 之前、結尾還在畫面內的長音也要畫，往回多看這條最長那顆音的長度
    for (let k = lowerBound(L.start, visLo - L.maxDur); k < L.start.length && L.start[k] <= visHi; k++) {
      if (L.end[k] < visLo) continue;
      const x = xOf(L.start[k]), x2 = Math.max(x + 3 * dpr, xOf(L.end[k]));
      const seg = L.seg[k];
      const played = seg < v.cursor && seg < from;
      const isNext = seg >= from && seg < to;
      ctx.fillStyle = played ? rgba(rgb, 0.3) : isNext ? rgba(rgb, 1) : rgba(rgb, 0.62);   // 視線集中在下一下：之後的音退一階
      const y = yOf(L.pitch[k]);
      ctx.fillRect(x, y, x2 - x, barH);
      if (isNext) { ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = dpr; ctx.strokeRect(x - 0.5, y - 0.5, x2 - x + 1, barH + 1); }
    }
    // 下一下：一顆大圓點（拍子模式在拍線上），快到了或落後時放大閃動
    if (from < L.onsetSec.length && v.state !== 'done') {
      const at = v.mode === 'beat' ? L.pressSec[from] : L.onsetSec[from];
      const x = Math.max(nowX, xOf(at)), dueIn = (at - pos) / rate;
      const urgent = v.state === 'behind' || dueIn < 0.35;
      const r = Math.max(2, (lh * 0.16) * (urgent ? 1 + 0.25 * pulse : 1));
      const cy = y0 + lh * 0.24;
      ctx.beginPath(); ctx.arc(x, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = v.state === 'behind' ? `rgba(255,170,60,${0.6 + 0.4 * pulse})` : v.state === 'substitute' ? 'rgba(255,128,128,0.7)' : rgba(rgb, 0.95);
      ctx.fill();
      ctx.lineWidth = 2 * dpr; ctx.strokeStyle = '#fff'; ctx.stroke();
      // 從圓點到「現在」線的引導線：還要多久
      if (x > nowX + r) { ctx.fillStyle = rgba(rgb, 0.55); ctx.fillRect(nowX, cy - dpr, x - r - nowX, 2 * dpr); }
    }
    // 「現在」線
    ctx.fillStyle = '#fff';
    ctx.fillRect(nowX - 1.5 * dpr, y0, 3 * dpr, lh);
  }
}
