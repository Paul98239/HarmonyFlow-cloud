// dynamics.js — 力度與音量：每一下的力道（鍵盤的按鍵位置、揮手的幅度與速度）、演奏者的表情（外接框，src/vision/expression.js）怎麼變成 velocity。純函式＋小狀態，排程器呼叫。
//
// 力道 intensity 與表情 expression 都是 0～1，0.5＝中性（原檔的力度不變）：
//  · 起音／拍子模式：原檔的力度乘上倍率（保留樂譜本身的強弱起伏，你的按法把整體推大推小）。
//  · 音樂家模式：力度主要由你的按法決定（樂譜力度只佔一小部分），「音值」由你掌握。
//  · 演奏者的表情：他自己的音再乘一個倍率；他帶頭時伴奏也跟著他的表情走（幅度小一點），合奏才有一致的情緒。
//  · 落拍的人（不是帶頭的人，落後偏離／脫隊或錯過）變小聲、被代打時更小聲：倍率隨時間平滑變化（不是一下子掉下去），聽起來是退到後面，不是斷掉。

// 應用層數字（不是規格）：
export const PRESS_RANGE = Object.freeze({ lo: 0.6, hi: 1.4 });        // 起音／拍子模式：力道 0 → ×0.6、1 → ×1.4
export const EXPRESSION_RANGE = Object.freeze({ lo: 0.75, hi: 1.25 });  // 表情對他自己的音
export const ENSEMBLE_EXPRESSION_RANGE = Object.freeze({ lo: 0.85, hi: 1.15 });   // 帶頭的人的表情對伴奏
export const BEHIND_GAIN = 0.78;       // 落拍
export const SUBSTITUTE_GAIN = 0.6;    // 電腦代打（小聲介入）
export const GAIN_TAU_MS = 1200;       // 落拍／代打的音量變化的時間常數（約 1 秒半漸變到位）
const MUSICIAN_SCORE_WEIGHT = 0.35;    // 音樂家模式：樂譜力度佔的比例

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 鍵盤上這個鍵（event.code）從左到右的位置 0～1（美式鍵盤的實體排列，每排依實際的錯位）。空白鍵在正中間（0.5，中性）。不認得的鍵回 0.5。
 */
const ROWS = [
  { offset: 0, keys: ['Backquote', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'] },
  { offset: 1.5, keys: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight', 'Backslash'] },
  { offset: 1.75, keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'] },
  { offset: 2.25, keys: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'] },
];
const KEYBOARD_WIDTH = 14.5;   // 鍵寬單位：最長那一排（含 Backspace／Enter 的位置）
const KEY_X = new Map();
for (const row of ROWS) row.keys.forEach((code, i) => KEY_X.set(code, (row.offset + i + 0.5) / KEYBOARD_WIDTH));
// 最左與最右的字元鍵分別對到 0 與 1，中間線性：讓整排鍵盤的範圍都用得到
const xs = [...KEY_X.values()], minX = Math.min(...xs), maxX = Math.max(...xs);
for (const [code, x] of KEY_X) KEY_X.set(code, (x - minX) / (maxX - minX));
KEY_X.set('Space', 0.5);
export const keyIntensity = (code) => KEY_X.get(code) ?? 0.5;

/** 力道 → 倍率（起音／拍子模式） */
export const pressMultiplier = (intensity) => lerp(PRESS_RANGE.lo, PRESS_RANGE.hi, clamp(intensity ?? 0.5, 0, 1));
/** 表情 → 倍率 */
export const expressionMultiplier = (e, range = EXPRESSION_RANGE) => lerp(range.lo, range.hi, clamp(e ?? 0.5, 0, 1));

/**
 * 演奏者的一顆音的力度。scoreVel＝原檔力度；mode＝演奏模式；intensity＝放出這顆音的那一下的力道；expression＝他目前的表情；gain＝落拍／代打的平滑倍率。
 */
export function performerVelocity(scoreVel, { mode, intensity = 0.5, expression = 0.5, gain = 1 }) {
  let v;
  if (mode === 'musician') {
    const i = clamp(intensity, 0, 1);
    v = lerp(24 + 103 * i, scoreVel * lerp(0.5, 1.5, i), MUSICIAN_SCORE_WEIGHT);
  } else {
    v = scoreVel * pressMultiplier(intensity);
  }
  v *= expressionMultiplier(expression) * gain;
  return clamp(Math.round(v), 1, 127);
}

/** 伴奏的一顆音的力度：跟著帶頭的人的表情（幅度比他自己的小） */
export function ensembleVelocity(scoreVel, leaderExpression = 0.5) {
  return clamp(Math.round(scoreVel * expressionMultiplier(leaderExpression, ENSEMBLE_EXPRESSION_RANGE)), 1, 127);
}

/**
 * 平滑的倍率：目標值改變時以時間常數 GAIN_TAU_MS 漸變過去（落拍、代打、回來都一樣慢慢變，不會突兀）。
 */
export class SmoothGain {
  constructor(value = 1) { this.value = value; this.target = value; this.atMs = null; }
  // 第一次呼叫只記下時刻（值維持建構時的 1），之後才往目標漸變
  at(target, nowMs) {
    if (this.atMs !== null && nowMs > this.atMs) this.value = target + (this.value - target) * Math.exp(-(nowMs - this.atMs) / GAIN_TAU_MS);
    this.target = target;
    this.atMs = this.atMs === null ? nowMs : Math.max(this.atMs, nowMs);
    return this.value;
  }
}

/**
 * 鍵盤手的「表情」：沒有攝影機，用他最近幾下的力道（按鍵位置）平滑出來——一直按右邊（大聲）的人，伴奏也跟著熱起來。
 */
export class PressExpression {
  constructor() { this.value = 0.5; }
  observe(intensity) { this.value += (clamp(intensity, 0, 1) - this.value) * 0.25; return this.value; }
}
