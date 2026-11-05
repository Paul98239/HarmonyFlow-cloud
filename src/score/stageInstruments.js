// stageInstruments.js — 舞台背景的樂器（index.html 的 #instrument-canvas）：每位演奏者一件，就是他選的聲部的樂器（GM 音色分類），
// 照他實際發出的每一顆音動作——鋼琴按下的就是那幾個琴鍵、鼓打的就是那一顆鼓（GM 鼓組的音高對到鼓件）、弦樂撥／拉的是那個音所在的弦、
// 管樂的按鍵（指法）跟著音高換、喇叭口吹出音符。音的開始與結束來自排程器的 noteOn／noteOff 事件（電腦代打時也是他的聲部在響，樂器照動、比較淡）；
// lookahead 提早送出的音照它真正響的時刻（dueMs）才動，畫面跟聲音同一刻。
//
// 主執行緒負擔：一張 canvas、最多 30fps、只在演奏中而且有東西在動時畫；樂器本體是幾何圖形（沒有圖片、陰影、濾鏡）；每幀耗時記在 stats。
// prefers-reduced-motion：不抖弦、不飄音符，只亮起來。

import { slotColor, hexRgb, rgba } from './palette.js';
import { getReservedBottom, getReservedTop } from './layout.js';
import { gmProgramNameZh } from '../midi/parts.js';

const FPS = 30;
const BASE_ALPHA = 0.5;        // 樂器本體的不透明度：它是背景，人（骨架）在它前面
const MAX_HELD_MS = 12000;     // 沒收到 noteOff 的音（漏掉的事件）最多亮這麼久
const AMBIENT_TAU_MS = 700;    // 伴奏的地板光暗下來的時間常數
// 「減少動態效果」：查一次、之後跟著系統設定的變化更新（每幀呼叫 matchMedia 在效能分析裡看得到）
const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
let reduced = motionQuery?.matches ?? false;
motionQuery?.addEventListener?.('change', (e) => { reduced = e.matches; });
const reduceMotion = () => reduced;

export const stats = { frames: 0, totalMs: 0, maxMs: 0 };

// 查問題、端到端測試用（main.js 的 __instruments()）：每件樂器這一刻在響的音高
let current = [];
export const instrumentDebug = () => {
  const now = performance.now();
  return current.map((i) => ({ slot: i.slot, kind: i.kind, program: i.program, sounding: noteStates(i, now).filter((s) => s.sounding).map((s) => s.pitch).sort((a, b) => a - b) }));
};

/** GM program（0～127）與是不是鼓組 → 畫法 */
export function instrumentKind(program, isDrum) {
  if (isDrum) return 'drums';
  const p = program | 0, f = p >> 3;
  if (p === 47) return 'timpani';
  if ([9, 10, 11, 12, 13, 14, 15, 108, 112, 114].includes(p)) return 'mallet';
  if (p === 22 || p === 109 || p === 111) return 'reed';                         // 口琴、風笛、嗩吶
  if (p === 110) return 'bowed';                                                // 民族提琴
  if (p === 46) return 'harp';
  if (f === 0 || f === 1 || f === 2 || f === 10) return 'keys';                 // 鋼琴、鋼片琴、風琴、手風琴、合成主音
  if (f === 3 || f === 4 || f === 13) return f === 4 ? 'bass' : 'guitar';       // 吉他、貝斯、西塔琴／班鳩琴／三味線／古箏
  if (f === 5 || (f === 6 && p <= 51)) return 'bowed';                          // 提琴家族、弦樂合奏
  if (p >= 52 && p <= 54) return 'voice';
  if (f === 7 || p === 55) return 'brass';
  if (f === 8) return 'reed';
  if (f === 9) return 'pipe';
  if (f === 14) return 'drums';
  return 'pad';                                                                 // 合成音墊、音效
}

// GM 鼓組的音高 → 鼓件
const DRUM_PIECE = (() => {
  const m = new Map();
  const put = (piece, pitches) => { for (const n of pitches) m.set(n, piece); };
  put('kick', [35, 36]);
  put('snare', [37, 38, 39, 40]);
  put('hihat', [42, 44, 46]);
  put('tomHi', [48, 50]);
  put('tomMid', [45, 47]);
  put('tomFloor', [41, 43]);
  put('crash', [49, 52, 55, 57]);
  put('ride', [51, 53, 59]);
  return m;
})();
const drumPiece = (pitch) => DRUM_PIECE.get(pitch) ?? 'perc';

// 小號三個活塞的按法（低到高的半音循環，近似真的指法：0＝開放）；直笛蓋住的孔數照音名
const VALVES = [[], [1, 2, 3], [1, 3], [2, 3], [1, 2], [1], [2]];
const valvesFor = (pitch) => VALVES[((pitch % 7) + 7) % 7];
const holesCovered = (pitch) => 7 - Math.round(((((pitch % 12) + 12) % 12) / 11) * 7);

/**
 * @param {{ getStatic: () => Array|null, getView: () => object, isActive: () => boolean, subscribe: (type: string, fn: Function) => Function }} deps
 *   getStatic＝scheduler.instrumentView()、getView＝scheduler.viewState()（誰在代打）、isActive＝演奏中、subscribe＝訂閱排程器事件（noteOn／noteOff）、
 *   getPositions＝揮手的人在畫面上的水平位置（vision.js 的 getPerformerPositions()：ID → 0～1），他的樂器放在他身後
 */
export function startStageInstruments({ getStatic, getView, isActive, subscribe, getPositions = () => null }) {
  const canvas = document.getElementById('instrument-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let size = { w: 0, h: 0, dpr: 1 }, lastDraw = 0, lastStatic = null, instruments = [], byStaff = new Map(), dirty = true, shown = false;

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1), r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; }
    size = { w, h, dpr };
    dirty = true;
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // 載入、改指派時重建：每位演奏者一件，記他的音域與正在響的音
  const rebuild = (stat) => {
    lastStatic = stat;
    instruments = (stat ?? []).map((s) => ({
      ...s, kind: instrumentKind(s.program, s.isDrum), rgb: hexRgb(slotColor(s.slot)),
      name: gmProgramNameZh(s.program, s.isDrum) || '',   // 樂器下面的小字：一眼知道哪一件是自己的
      notes: [],            // { pitch, at, off, vel }：at＝響的時刻（performance.now 時間軸）、off＝結束的時刻（還沒收到是 Infinity）
      bowDir: 1,            // 弓：每個新的音換一次方向
      x: null,              // 畫面上的水平中心（0～1），往目標位置平滑移動
    }));
    byStaff = new Map();
    for (const inst of instruments) for (const id of inst.staffIds) byStaff.set(id, inst);
    current = instruments;
    dirty = true;
  };

  // 事件的時刻換到 performance.now 的時間軸：帶時間戳（lookahead 提早送出）的照它真正響的時刻
  const realAt = (e, dueMs) => performance.now() + (e.timed && Number.isFinite(dueMs) ? Math.max(0, dueMs - e.clockMs) : 0);
  // 伴奏的「呼吸」：電腦伴奏的每顆音（照它真正響的時刻）把地板的暖光推亮一點，之後慢慢暗下來——看得出後面的樂團正在跟著你演奏，你停下來它也靜下來
  const ambient = { level: 0, at: performance.now(), pending: [] };
  subscribe('noteOn', (e) => {
    if (e.kind === 'assist') { ambient.pending.push([realAt(e, e.dueMs), (e.velocity ?? 80) / 127]); if (ambient.pending.length > 256) ambient.pending.shift(); dirty = true; return; }
    const inst = byStaff.get(e.staffId);
    if (!inst) return;
    const at = realAt(e, e.dueMs);
    inst.bowDir = -inst.bowDir;
    inst.notes.push({ pitch: e.note.midiNote, id: e.noteId, at, off: Infinity, vel: (e.velocity ?? 90) / 127, dir: inst.bowDir });
    if (inst.notes.length > 64) inst.notes.splice(0, inst.notes.length - 64);
    dirty = true;
  });
  subscribe('noteOff', (e) => {
    const inst = byStaff.get(e.staffId);
    if (!inst) return;
    const off = realAt(e, e.offMs);
    // 同一顆音（id）最早還沒結束的那一筆
    const n = inst.notes.find((x) => x.off === Infinity && (e.noteId !== null ? x.id === e.noteId : x.pitch === e.note.midiNote));
    if (n) n.off = Math.max(n.at, off);
    dirty = true;
  });

  const frame = (now) => {
    requestAnimationFrame(frame);
    if (now - lastDraw < 1000 / FPS - 2) return;
    let stat = null, view = null;
    const active = isActive();
    if (active) { try { stat = getStatic(); view = getView(); } catch { stat = null; } }
    if (stat !== lastStatic) rebuild(stat);
    const show = active && instruments.length > 0;
    if (show !== shown) { shown = show; canvas.hidden = !show; dirty = true; }
    if (!show) return;
    // 清掉結束很久的音；有音在響或剛結束（餘韻）才需要重畫
    let animating = false;
    for (const inst of instruments) {
      inst.notes = inst.notes.filter((n) => now - Math.min(n.off, n.at + MAX_HELD_MS) < 1200);
      if (inst.notes.length) animating = true;
    }
    const moved = place(instruments, getPositions(), now - lastDraw);
    // 伴奏的光：到時刻的音加進去（越多越亮、有上限），指數衰減（AMBIENT_TAU_MS）
    ambient.level *= Math.exp(-Math.max(0, now - ambient.at) / AMBIENT_TAU_MS);
    ambient.at = now;
    ambient.pending = ambient.pending.filter(([at, v]) => { if (at > now) return true; ambient.level = Math.min(1, ambient.level + 0.12 * (0.4 + 0.6 * v)); return false; });
    if (ambient.level > 0.01) animating = true;
    if (!animating && !dirty && !moved) return;
    lastDraw = now;
    dirty = false;
    const t0 = performance.now();
    const subs = new Set(view?.performers.filter((p) => p.state === 'substitute').map((p) => p.slot));
    drawAll(ctx, size, instruments, now, subs, reduceMotion(), ambient.level);
    const ms = performance.now() - t0;
    stats.frames++; stats.totalMs += ms; if (ms > stats.maxMs) stats.maxMs = ms;
  };
  requestAnimationFrame(frame);
}

// 每件樂器的水平位置：揮手的人在鏡頭裡就放在他身後，鍵盤手與不在鏡頭裡的人放在空著的地方（照槽位順序、從左邊排）；
// 互相不重疊（間隔至少一格）、不出畫面；位置平滑移動（人走動時樂器跟著滑過去，不會跳）。回傳有沒有明顯移動（要不要重畫）
// 格子寬（cell）：畫面放得下的上限（每件最多 1/5 寬），人站得近時縮到人跟人之間的距離（最小 MIN_CELL），每件樂器還是在他身後
const PLACE_TAU_MS = 280, MIN_CELL = 0.11;
let layoutCell = 0.2;
function place(instruments, positions, dtMs) {
  const n = instruments.length;
  if (!n) return false;
  const want = instruments.map((inst, i) => {
    const x = typeof inst.slot === 'number' ? positions?.get(inst.slot) : undefined;
    return { inst, x: Number.isFinite(x) ? x : null, order: i };
  });
  const xs = want.filter((w) => w.x !== null).map((w) => w.x).sort((a, b) => a - b);
  let gap = Infinity;
  for (let i = 1; i < xs.length; i++) gap = Math.min(gap, xs[i] - xs[i - 1]);
  const cell = Math.max(MIN_CELL, Math.min(0.2, 0.92 / n, gap));
  const k = Number.isFinite(dtMs) ? Math.exp(-Math.max(0, dtMs) / PLACE_TAU_MS) : 0;
  const prevCell = layoutCell;
  layoutCell = cell + (layoutCell - cell) * k;
  // 沒有位置的人：依序放進一格一格的空位（從左邊）
  const free = [];
  for (let k = 0; k < Math.floor(1 / cell); k++) free.push((k + 0.5) * cell);
  for (const w of want) if (w.x === null) {
    let best = 0, bestD = -1;
    free.forEach((fx, k) => { const d = Math.min(...want.filter((o) => o.x !== null && o !== w).map((o) => Math.abs(o.x - fx)), Infinity); if (d > bestD + 1e-9) { bestD = d; best = k; } });
    w.x = free.splice(best, 1)[0] ?? 0.5;
  }
  // 由左到右排開：相鄰至少一格，再整排推回畫面內
  want.sort((a, b) => a.x - b.x || a.order - b.order);
  for (let i = 1; i < n; i++) want[i].x = Math.max(want[i].x, want[i - 1].x + cell);
  const over = want[n - 1].x - (1 - cell / 2);
  if (over > 0) for (const w of want) w.x -= over;
  for (let i = n - 2; i >= 0; i--) want[i].x = Math.min(want[i].x, want[i + 1].x - cell);
  const under = cell / 2 - want[0].x;
  if (under > 0) for (const w of want) w.x += under;
  let moved = Math.abs(layoutCell - prevCell) > 0.0008;
  for (const w of want) {
    const prev = w.inst.x;
    w.inst.x = prev === null ? w.x : w.x + (prev - w.x) * k;
    if (prev === null || Math.abs(w.inst.x - prev) > 0.0008) moved = true;
  }
  return moved;
}

// 這一刻每顆音的狀態：sounding＝正在響（按著）、env＝起音的衝擊（1 → 0，打擊與撥弦的動作用）
function noteStates(inst, now) {
  const out = [];
  for (const n of inst.notes) {
    if (now < n.at) continue;
    const off = Math.min(n.off, n.at + MAX_HELD_MS);
    const sounding = now < off;
    const env = Math.exp(-(now - n.at) / 260) * (sounding ? 1 : Math.exp(-(now - off) / 120));
    out.push({ pitch: n.pitch, vel: n.vel, sounding, env, age: now - n.at, dir: n.dir });
  }
  return out;
}

function drawAll(ctx, { w: W, h: H }, instruments, now, subs, still, ambient = 0) {
  ctx.clearRect(0, 0, W, H);
  const top = H * getReservedTop(), bottom = H * (1 - getReservedBottom());
  const band = Math.max(1, bottom - top), n = instruments.length;
  // 地板的暖光跟著伴奏呼吸（減少動態效果時固定一個淡淡的亮度）
  const glowA = still ? 0.06 : 0.16 * ambient;
  if (glowA > 0.004) {
    const g = ctx.createRadialGradient(W / 2, bottom, 0, W / 2, bottom, W * 0.55);
    g.addColorStop(0, `rgba(255, 176, 100, ${glowA})`);
    g.addColorStop(1, 'rgba(255, 176, 100, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, top, W, bottom - top);
  }
  // 放在舞台下半（人站在前面）、各自的水平位置（place()）：每件的格子寬不超過畫面的 1/5
  const cellW = W * layoutCell, cellH = Math.min(band * 0.46, cellW * 0.78);
  const labelPx = Math.max(11 * (W / Math.max(1, ctx.canvas.clientWidth || W)), cellH * 0.13);
  const y = bottom - cellH - labelPx * 1.5 - band * 0.02;
  instruments.forEach((inst) => {
    const cx = (inst.x ?? 0.5) * W;
    const box = { x: cx - cellW * 0.42, y, w: cellW * 0.84, h: cellH };
    const notes = noteStates(inst, now);
    const alpha = subs.has(inst.slot) ? BASE_ALPHA * 0.55 : BASE_ALPHA;
    ctx.save();
    // 底下一圈柔光：有音在響時亮一點（整件樂器「正在被演奏」）
    const glow = Math.min(1, notes.reduce((a, s) => Math.max(a, s.sounding ? 0.55 + 0.45 * s.env : s.env), 0));
    if (glow > 0.02) {
      const g = ctx.createRadialGradient(box.x + box.w / 2, box.y + box.h * 0.6, box.h * 0.1, box.x + box.w / 2, box.y + box.h * 0.6, box.w * 0.62);
      g.addColorStop(0, rgba(inst.rgb, 0.22 * glow));
      g.addColorStop(1, rgba(inst.rgb, 0));
      ctx.fillStyle = g;
      ctx.fillRect(box.x - box.w * 0.15, box.y - box.h * 0.2, box.w * 1.3, box.h * 1.4);
    }
    (DRAW[inst.kind] ?? DRAW.pad)(ctx, box, inst, notes, alpha, now, still);
    if (inst.name) {
      ctx.globalAlpha = 1;
      ctx.font = `700 ${Math.round(labelPx)}px system-ui, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = rgba(inst.rgb, subs.has(inst.slot) ? 0.5 : 0.85);
      ctx.fillText(inst.name, box.x + box.w / 2, box.y + box.h + labelPx * 0.35, box.w * 1.1);
    }
    ctx.restore();
  });
}

// ── 每一種樂器的畫法：box＝它的格子、notes＝這一刻的音（noteStates）、alpha＝本體的不透明度 ──
const BODY = (a) => `rgba(255, 236, 214, ${a})`;      // 暖白（木頭、象牙）
const DARK = (a) => `rgba(70, 48, 38, ${a})`;         // 深棕（黑鍵、琴頸）
const WOOD = (a) => `rgba(196, 134, 86, ${a})`;       // 木頭
const BRASS = (a) => `rgba(236, 190, 92, ${a})`;      // 銅管

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

// 音高 → 0～1 的位置（這件樂器自己的音域）
const span = (inst, pitch) => (inst.hi > inst.lo ? (pitch - inst.lo) / (inst.hi - inst.lo) : 0.5);

const DRAW = {
  keys(ctx, b, inst, notes, a) {
    // 琴鍵：整個八度、涵蓋他的音域（至少兩個八度，最多五個；超出的音畫在最近的那一端）
    let lo = Math.floor(inst.lo / 12) * 12, hi = Math.ceil((inst.hi + 1) / 12) * 12;
    if (hi - lo < 24) { const mid = Math.round((lo + hi) / 24) * 12; lo = mid - 12; hi = mid + 12; }
    if (hi - lo > 60) { const mid = Math.round((inst.lo + inst.hi) / 24) * 12; lo = mid - 30 - (mid - 30) % 12; hi = lo + 60; }
    const isBlack = (p) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
    const whites = [];
    for (let p = lo; p < hi; p++) if (!isBlack(p)) whites.push(p);
    const down = new Map();
    for (const s of notes) if (s.sounding) down.set(Math.min(hi - 1, Math.max(lo, s.pitch)), s);
    const kh = b.h * 0.62, ky = b.y + b.h - kh, kw = b.w / whites.length;
    // 琴身
    roundRect(ctx, b.x - b.w * 0.03, ky - b.h * 0.16, b.w * 1.06, kh + b.h * 0.2, b.h * 0.05);
    ctx.fillStyle = DARK(a * 0.9); ctx.fill();
    whites.forEach((p, i) => {
      const s = down.get(p), dy = s ? kh * 0.03 : 0;
      ctx.fillStyle = s ? rgba(inst.rgb, Math.min(1, a + 0.4)) : BODY(a);
      ctx.fillRect(b.x + i * kw + 0.5, ky + dy, kw - 1, kh - dy);
    });
    let wi = 0;
    for (let p = lo; p < hi; p++) {
      if (!isBlack(p)) { wi++; continue; }
      const s = down.get(p), x = b.x + wi * kw - kw * 0.3;
      ctx.fillStyle = s ? rgba(inst.rgb, Math.min(1, a + 0.45)) : DARK(Math.min(1, a + 0.3));
      ctx.fillRect(x, ky, kw * 0.6, kh * (s ? 0.6 : 0.58));
    }
  },

  mallet(ctx, b, inst, notes, a, now, still) {
    // 木琴：一排音條（左低右高、越高越短），打到的那一條亮起來，琴槌落在它上面再彈起
    const n = Math.max(8, Math.min(22, inst.hi - inst.lo + 1)), bw = b.w / n;
    const barOf = (p) => Math.min(n - 1, Math.max(0, Math.round(span(inst, p) * (n - 1))));
    const hit = new Map();
    for (const s of notes) { const k = barOf(s.pitch); if (!hit.has(k) || hit.get(k).env < s.env) hit.set(k, s); }
    ctx.fillStyle = DARK(a * 0.8);
    ctx.fillRect(b.x, b.y + b.h * 0.42, b.w, b.h * 0.05);
    ctx.fillRect(b.x, b.y + b.h * 0.82, b.w, b.h * 0.05);
    for (let k = 0; k < n; k++) {
      const len = b.h * (0.62 - 0.3 * (k / (n - 1))), s = hit.get(k);
      const e = s ? Math.max(s.env, s.sounding ? 0.35 : 0) : 0;
      ctx.fillStyle = e > 0.02 ? rgba(inst.rgb, Math.min(1, a + 0.5 * e)) : WOOD(a);
      roundRect(ctx, b.x + k * bw + bw * 0.1, b.y + b.h * 0.95 - len, bw * 0.8, len, bw * 0.15); ctx.fill();
    }
    // 琴槌：最近一顆音的位置，剛打下去時貼著音條，之後抬起來
    const last = notes.reduce((m, s) => (!m || s.age < m.age ? s : m), null);
    if (last) {
      const k = barOf(last.pitch), lift = still ? 0 : (1 - last.env) * b.h * 0.18;
      const hx = b.x + (k + 0.5) * bw, hy = b.y + b.h * 0.95 - b.h * (0.62 - 0.3 * (k / (n - 1))) - bw * 0.35 - lift;
      ctx.strokeStyle = DARK(Math.min(1, a + 0.3)); ctx.lineWidth = Math.max(1.5, bw * 0.12);
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + b.w * 0.18, hy - b.h * 0.3); ctx.stroke();
      ctx.fillStyle = rgba(inst.rgb, Math.min(1, a + 0.4));
      ctx.beginPath(); ctx.arc(hx, hy, bw * 0.38, 0, Math.PI * 2); ctx.fill();
    }
  },

  guitar: (ctx, b, inst, notes, a, now, still) => strings(ctx, b, inst, notes, a, now, still, { count: 6, body: 'guitar' }),
  bass: (ctx, b, inst, notes, a, now, still) => strings(ctx, b, inst, notes, a, now, still, { count: 4, body: 'guitar' }),
  harp: (ctx, b, inst, notes, a, now, still) => strings(ctx, b, inst, notes, a, now, still, { count: 12, body: 'harp' }),
  bowed: (ctx, b, inst, notes, a, now, still) => strings(ctx, b, inst, notes, a, now, still, { count: 4, body: 'violin', bow: true }),

  brass(ctx, b, inst, notes, a, now, still) {
    // 小號：管身、三個活塞（按法跟著音高）、喇叭口吹出音符
    const cy = b.y + b.h * 0.55, s = notes.find((x) => x.sounding) ?? null;
    ctx.strokeStyle = BRASS(a); ctx.lineWidth = Math.max(2, b.h * 0.06); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(b.x + b.w * 0.05, cy); ctx.lineTo(b.x + b.w * 0.7, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(b.x + b.w * 0.3, cy); ctx.bezierCurveTo(b.x + b.w * 0.3, cy + b.h * 0.3, b.x + b.w * 0.62, cy + b.h * 0.3, b.x + b.w * 0.62, cy); ctx.stroke();
    // 喇叭口
    ctx.fillStyle = s ? rgba(inst.rgb, Math.min(1, a + 0.35 * (0.5 + s.env))) : BRASS(a);
    ctx.beginPath(); ctx.moveTo(b.x + b.w * 0.7, cy - b.h * 0.04); ctx.lineTo(b.x + b.w * 0.95, cy - b.h * 0.22); ctx.lineTo(b.x + b.w * 0.95, cy + b.h * 0.22); ctx.lineTo(b.x + b.w * 0.7, cy + b.h * 0.04); ctx.closePath(); ctx.fill();
    const pressed = s ? valvesFor(s.pitch) : [];
    for (let v = 1; v <= 3; v++) {
      const vx = b.x + b.w * (0.34 + v * 0.07), down = pressed.includes(v);
      ctx.fillStyle = down ? rgba(inst.rgb, Math.min(1, a + 0.45)) : BRASS(Math.min(1, a + 0.15));
      ctx.fillRect(vx - b.w * 0.02, cy - b.h * (down ? 0.2 : 0.28), b.w * 0.04, b.h * 0.22);
    }
    puffs(ctx, b.x + b.w * 0.97, cy, b, inst, notes, a, still);
  },

  reed(ctx, b, inst, notes, a, now, still) {
    // 薩克斯風／豎笛：斜的管身、一排按鍵（蓋住幾個照音高）、喇叭口吹出音符
    const s = notes.find((x) => x.sounding) ?? null, k = s ? holesCovered(s.pitch) : 0;
    const x1 = b.x + b.w * 0.3, y1 = b.y + b.h * 0.08, x2 = b.x + b.w * 0.55, y2 = b.y + b.h * 0.85;
    ctx.strokeStyle = BRASS(a); ctx.lineWidth = Math.max(3, b.w * 0.08); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.quadraticCurveTo(x2 + b.w * 0.05, y2 + b.h * 0.12, x2 + b.w * 0.2, y2 - b.h * 0.05); ctx.stroke();
    for (let i = 0; i < 7; i++) {
      const t = 0.15 + i * 0.1, hx = x1 + (x2 - x1) * t, hy = y1 + (y2 - y1) * t;
      ctx.fillStyle = i < k ? rgba(inst.rgb, Math.min(1, a + 0.45)) : DARK(a);
      ctx.beginPath(); ctx.arc(hx + b.w * 0.05, hy, Math.max(1.5, b.w * 0.022), 0, Math.PI * 2); ctx.fill();
    }
    puffs(ctx, x2 + b.w * 0.22, y2 - b.h * 0.08, b, inst, notes, a, still);
  },

  pipe(ctx, b, inst, notes, a, now, still) {
    // 長笛／直笛：橫的管身、七個孔（蓋住幾個照音高），吹口飄出音符
    const s = notes.find((x) => x.sounding) ?? null, k = s ? holesCovered(s.pitch) : 0, cy = b.y + b.h * 0.55;
    roundRect(ctx, b.x + b.w * 0.04, cy - b.h * 0.05, b.w * 0.9, b.h * 0.1, b.h * 0.05);
    ctx.fillStyle = BODY(a); ctx.fill();
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = i < k ? rgba(inst.rgb, Math.min(1, a + 0.45)) : DARK(a);
      ctx.beginPath(); ctx.arc(b.x + b.w * (0.35 + i * 0.08), cy, Math.max(1.5, b.h * 0.028), 0, Math.PI * 2); ctx.fill();
    }
    puffs(ctx, b.x + b.w * 0.1, cy - b.h * 0.08, b, inst, notes, a, still);
  },

  drums(ctx, b, inst, notes, a, now, still) {
    // 爵士鼓：每顆音對到它的鼓件（GM 鼓組），打到的那一件亮起來、跳一下，鼓棒落在上面
    const env = new Map();
    for (const s of notes) { const p = drumPiece(s.pitch); env.set(p, Math.max(env.get(p) ?? 0, s.env * (0.6 + 0.4 * s.vel))); }
    const W = b.w, H = b.h, X = b.x, Y = b.y;
    const pieces = {
      crash: { x: 0.12, y: 0.12, rx: 0.12, ry: 0.035, kind: 'cym' }, ride: { x: 0.88, y: 0.16, rx: 0.12, ry: 0.035, kind: 'cym' },
      hihat: { x: 0.1, y: 0.42, rx: 0.09, ry: 0.025, kind: 'cym' },
      tomHi: { x: 0.38, y: 0.3, rx: 0.08, ry: 0.06, kind: 'drum' }, tomMid: { x: 0.6, y: 0.3, rx: 0.09, ry: 0.065, kind: 'drum' },
      snare: { x: 0.26, y: 0.6, rx: 0.1, ry: 0.06, kind: 'drum' }, tomFloor: { x: 0.8, y: 0.62, rx: 0.11, ry: 0.07, kind: 'drum' },
      kick: { x: 0.5, y: 0.7, rx: 0.17, ry: 0.22, kind: 'kick' }, perc: { x: 0.5, y: 0.08, rx: 0.05, ry: 0.04, kind: 'drum' },
    };
    for (const [name, pc] of Object.entries(pieces)) {
      const e = env.get(name) ?? 0, sc = still ? 1 : 1 + 0.12 * e;
      const cx = X + pc.x * W, cy = Y + pc.y * H, rx = pc.rx * W * sc, ry = pc.ry * (pc.kind === 'kick' ? H : W) * sc;
      if (name === 'perc' && e < 0.02) continue;
      ctx.fillStyle = e > 0.02 ? rgba(inst.rgb, Math.min(1, a + 0.5 * e)) : pc.kind === 'cym' ? BRASS(a) : pc.kind === 'kick' ? WOOD(a) : BODY(a);
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      if (pc.kind === 'kick') { ctx.strokeStyle = DARK(a); ctx.lineWidth = Math.max(1, W * 0.01); ctx.stroke(); }
      if (e > 0.25 && pc.kind !== 'kick') {
        // 鼓棒：從斜上方落到鼓面
        ctx.strokeStyle = DARK(Math.min(1, a + 0.3)); ctx.lineWidth = Math.max(1.5, W * 0.012);
        ctx.beginPath(); ctx.moveTo(cx - rx * 0.2, cy - ry * 0.3); ctx.lineTo(cx - rx * 0.2 - W * 0.08, cy - H * 0.2 * (1 - e * 0.5)); ctx.stroke();
      }
    }
  },

  timpani(ctx, b, inst, notes, a, now, still) {
    const e = notes.reduce((m, s) => Math.max(m, s.env), 0), sc = still ? 1 : 1 + 0.08 * e;
    const cx = b.x + b.w / 2, cy = b.y + b.h * 0.45;
    ctx.fillStyle = BRASS(a);
    ctx.beginPath(); ctx.moveTo(cx - b.w * 0.32, cy); ctx.quadraticCurveTo(cx, cy + b.h * 0.7, cx + b.w * 0.32, cy); ctx.closePath(); ctx.fill();
    ctx.fillStyle = e > 0.02 ? rgba(inst.rgb, Math.min(1, a + 0.5 * e)) : BODY(a);
    ctx.beginPath(); ctx.ellipse(cx, cy, b.w * 0.34 * sc, b.h * 0.08 * sc, 0, 0, Math.PI * 2); ctx.fill();
  },

  voice(ctx, b, inst, notes, a, now, still) {
    // 合唱：三個人的輪廓，正在唱時嘴張開，頭上飄出音符（音越高飄越高）
    const singing = notes.filter((s) => s.sounding);
    for (let i = 0; i < 3; i++) {
      const cx = b.x + b.w * (0.25 + i * 0.25), cy = b.y + b.h * (0.45 + (i === 1 ? -0.05 : 0.03));
      ctx.fillStyle = BODY(a);
      ctx.beginPath(); ctx.arc(cx, cy, b.h * 0.13, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx, cy + b.h * 0.35, b.h * 0.18, b.h * 0.17, 0, Math.PI, 0); ctx.fill();
      const open = singing.length ? 0.35 + 0.65 * Math.max(...singing.map((s) => s.vel)) : 0.1;
      ctx.fillStyle = singing.length ? rgba(inst.rgb, Math.min(1, a + 0.4)) : DARK(a);
      ctx.beginPath(); ctx.ellipse(cx, cy + b.h * 0.05, b.h * 0.04, b.h * 0.035 * (0.3 + open), 0, 0, Math.PI * 2); ctx.fill();
    }
    puffs(ctx, b.x + b.w * 0.5, b.y + b.h * 0.25, b, inst, notes, a, still);
  },

  pad(ctx, b, inst, notes, a, now, still) {
    // 合成音墊、音效：一圈圈的聲波，正在響的音越多圈越多、越亮
    const cx = b.x + b.w / 2, cy = b.y + b.h * 0.55, on = notes.filter((s) => s.sounding);
    ctx.fillStyle = BODY(a);
    roundRect(ctx, cx - b.w * 0.2, cy - b.h * 0.12, b.w * 0.4, b.h * 0.24, b.h * 0.06); ctx.fill();
    ctx.strokeStyle = rgba(inst.rgb, Math.min(1, a + 0.3)); ctx.lineWidth = Math.max(1, b.h * 0.02);
    for (let i = 0; i < Math.min(4, on.length); i++) {
      const r = b.h * (0.2 + 0.1 * i + (still ? 0 : ((now / 900 + i * 0.25) % 1) * 0.08));
      ctx.globalAlpha = 0.6 - i * 0.12;
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI * 0.8, -Math.PI * 0.2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  },
};

// 弦樂器：琴身＋count 條弦（低音在左），每顆音落在它音域裡對應的那條弦上：撥弦（吉他、貝斯、豎琴）照起音的衝擊抖、拉弦（提琴）照響著的時間抖，弓每個新的音換一次方向
function strings(ctx, b, inst, notes, a, now, still, { count, body, bow = false }) {
  const cx = b.x + b.w / 2;
  if (body === 'guitar') {
    ctx.fillStyle = WOOD(a);
    ctx.beginPath(); ctx.ellipse(cx - b.w * 0.16, b.y + b.h * 0.62, b.w * 0.2, b.h * 0.3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx - b.w * 0.02, b.y + b.h * 0.62, b.w * 0.15, b.h * 0.24, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = DARK(a);
    ctx.fillRect(cx - b.w * 0.02, b.y + b.h * 0.56, b.w * 0.5, b.h * 0.12);
    ctx.beginPath(); ctx.arc(cx - b.w * 0.12, b.y + b.h * 0.62, b.h * 0.08, 0, Math.PI * 2); ctx.fill();
  } else if (body === 'violin') {
    ctx.fillStyle = WOOD(a);
    ctx.beginPath(); ctx.ellipse(cx, b.y + b.h * 0.35, b.w * 0.15, b.h * 0.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx, b.y + b.h * 0.7, b.w * 0.18, b.h * 0.24, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = DARK(a);
    ctx.fillRect(cx - b.w * 0.025, b.y, b.w * 0.05, b.h * 0.5);
  } else {
    ctx.strokeStyle = WOOD(a); ctx.lineWidth = Math.max(3, b.w * 0.05);
    ctx.beginPath(); ctx.moveTo(b.x + b.w * 0.15, b.y + b.h * 0.95); ctx.lineTo(b.x + b.w * 0.2, b.y + b.h * 0.05); ctx.quadraticCurveTo(b.x + b.w * 0.6, b.y + b.h * 0.05, b.x + b.w * 0.85, b.y + b.h * 0.4); ctx.lineTo(b.x + b.w * 0.15, b.y + b.h * 0.95); ctx.stroke();
  }
  // 弦的位置：吉他、貝斯橫的（沿著琴頸），提琴、豎琴直的
  const horizontal = body === 'guitar';
  const lineOf = (k) => (horizontal
    ? { x1: cx - b.w * 0.3, y1: b.y + b.h * (0.575 + k * (0.09 / Math.max(1, count - 1))), x2: cx + b.w * 0.48, y2: b.y + b.h * (0.575 + k * (0.09 / Math.max(1, count - 1))) }
    : body === 'violin'
      ? { x1: cx + (k - (count - 1) / 2) * b.w * 0.022, y1: b.y + b.h * 0.02, x2: cx + (k - (count - 1) / 2) * b.w * 0.05, y2: b.y + b.h * 0.88 }
      : { x1: b.x + b.w * (0.22 + k * (0.6 / count)), y1: b.y + b.h * (0.08 + k * 0.025), x2: b.x + b.w * (0.22 + k * (0.6 / count)), y2: b.y + b.h * (0.92 - k * 0.04) });
  const stringOf = (p) => Math.min(count - 1, Math.max(0, Math.floor(span(inst, p) * count)));
  const vib = new Map();
  for (const s of notes) {
    const k = stringOf(s.pitch), amp = bow ? (s.sounding ? 0.6 + 0.4 * s.vel : s.env) : s.env * (0.5 + 0.5 * s.vel);
    vib.set(k, Math.max(vib.get(k) ?? 0, amp));
  }
  for (let k = 0; k < count; k++) {
    const L = lineOf(k), v = vib.get(k) ?? 0;
    ctx.strokeStyle = v > 0.02 ? rgba(inst.rgb, Math.min(1, a + 0.5 * Math.min(1, v + 0.3))) : BODY(Math.min(1, a + 0.1));
    ctx.lineWidth = Math.max(1, (horizontal ? b.h : b.w) * 0.008 * (1 + (count - k) / count));
    ctx.beginPath(); ctx.moveTo(L.x1, L.y1);
    // 抖動：弦的中點往旁邊偏，照時間來回（每秒十幾次；減少動態時不抖）
    const off = still || v <= 0.02 ? 0 : Math.sin(now / 28 + k) * v * b.h * 0.035;
    const mx = (L.x1 + L.x2) / 2 + (horizontal ? 0 : off), my = (L.y1 + L.y2) / 2 + (horizontal ? off : 0);
    ctx.quadraticCurveTo(mx, my, L.x2, L.y2); ctx.stroke();
  }
  if (bow) {
    // 弓：橫過琴弦，正在拉時來回移動，每個新的音換方向
    const playing = notes.filter((s) => s.sounding);
    const newest = playing.reduce((m, s) => (!m || s.age < m.age ? s : m), null);
    // 弓從上一個音停下的那一端往另一端拉（新的音換方向），拉滿 1.2 秒
    const shift = newest && !still ? newest.dir * (Math.min(1, newest.age / 1200) - 0.5) * b.w * 0.5 : 0;
    const by = b.y + b.h * 0.62;
    ctx.strokeStyle = newest ? rgba(inst.rgb, Math.min(1, a + 0.35)) : DARK(a);
    ctx.lineWidth = Math.max(1.5, b.h * 0.018);
    ctx.beginPath(); ctx.moveTo(b.x - b.w * 0.05 + shift, by - b.h * 0.08); ctx.lineTo(b.x + b.w * 1.05 + shift, by + b.h * 0.08); ctx.stroke();
  }
}

// 從 (x, y) 飄出的音符：每顆剛響的音一個，往上飄、淡掉；音越高飄越高
function puffs(ctx, x, y, b, inst, notes, a, still) {
  if (still) return;
  ctx.fillStyle = rgba(inst.rgb, Math.min(1, a + 0.3));
  ctx.font = `${Math.max(10, Math.round(b.h * 0.18))}px serif`;
  for (const s of notes) {
    if (s.age > 1100) continue;
    const t = s.age / 1100, rise = b.h * (0.25 + 0.35 * span(inst, s.pitch)) * t;
    ctx.globalAlpha = (1 - t) * 0.9;
    ctx.fillText('♪', x + Math.sin(t * 5 + s.pitch) * b.w * 0.04, y - rise);
  }
  ctx.globalAlpha = 1;
}
