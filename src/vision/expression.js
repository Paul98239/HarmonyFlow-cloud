// expression.js — 演奏者的「情緒」：用外接框框住這個人的節點，框放大縮小、動得快慢 → 表情 energy（0～1，0.5 中性）。排程器用它調他的音（與他帶頭時伴奏）的力度（src/midi/dynamics.js）。
//
// 三個不能犯的錯，各自怎麼處理：
//  · 走近／走遠不是動作變大／變小：框的大小與速度一律以這個人的尺度（tracking.js 的 track.scale，正面時≈肩寬、側身也不縮）為單位；他走近，尺度跟著變大，比值不變。
//  · 坐著時下半身常在畫面外：只用上半身的節點（鼻子、肩、肘、腕、手掌），看不到的點不算；髖、膝、踝從來不用。
//  · 動作天生較小的人不能永遠小聲：主要跟他自己最近一段時間比（以他的中位數為中性、第 10 到第 90 百分位的寬度為尺），再混一點絕對值；範圍有下限，靜止不動的人不會被雜訊放大。
// 量的是「動作有多大、多快」：框的大小與手速在一次揮手裡本來就一直變，所以取最近 ENVELOPE_MS 內的最大值（包絡），不看瞬間值。
//
// 可擴充：不同的動作（揮手、緩慢舞動、指揮）用不同的 MOTION_PROFILES——框的大小與速度各佔多少、平滑多慢。之後新增動作只要加一個 profile（或換一個 features → energy 的函式），
// 排程器那一頭只吃 energy，不用改。

// 上半身的節點：0 鼻子、11/12 肩、13/14 肘、15/16 腕、17～22 手掌
export const UPPER_BODY = Object.freeze([0, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
const WRISTS = [15, 16];

/**
 * 動作的設定：size／speed＝框的大小與手的速度各佔多少；tauMs＝energy 的平滑時間常數（越大越不會一下子變）；
 * absWeight＝絕對值佔多少（其餘是跟他自己的範圍比）。
 */
export const MOTION_PROFILES = Object.freeze({
  wave: Object.freeze({ size: 0.55, speed: 0.45, tauMs: 600, absWeight: 0.3 }),
  // 緩慢舞動：整個身體的伸展比速度重要，變化也慢
  dance: Object.freeze({ size: 0.75, speed: 0.25, tauMs: 1500, absWeight: 0.3 }),
  // 指揮：手的速度（拍子的力道）比框的大小重要
  conduct: Object.freeze({ size: 0.4, speed: 0.6, tauMs: 500, absWeight: 0.3 }),
});

const HISTORY_MS = 20000;      // 個人範圍看最近這麼久
const SAMPLE_MS = 100;         // 個人範圍的取樣間隔
const ENVELOPE_MS = 1000;      // 動作大小與速度取最近這麼久內的最大值
const MIN_SIZE_RANGE = 0.8;    // 框大小（尺度單位）的個人範圍下限：比這個小的變化當成雜訊
const MIN_SPEED_RANGE = 2;     // 手速（尺度／秒）的個人範圍下限

const clamp01 = (x) => Math.min(1, Math.max(0, x));
function percentile(xs, q) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/**
 * 這一幀的特徵：外接框（正規化座標，畫圖用）、框的大小（框寬×框高開根號，以尺度為單位）、看得到的點數。看不到肩膀就回 null。
 * @param {{ smoothed: {x,y,visible}[], scale: number, aspect: number }} track
 */
export function boxFeatures(track) {
  const lm = track.smoothed, sc = Math.max(1e-3, track.scale);
  if (!lm[11]?.visible || !lm[12]?.visible) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  for (const i of UPPER_BODY) {
    const p = lm[i];
    if (!p?.visible) continue;
    n++;
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  const w = (x1 - x0) / sc, h = ((y1 - y0) * track.aspect) / sc;
  return { box: { x0, y0, x1, y1 }, size: Math.sqrt(Math.max(1e-6, w * h)), points: n };
}

export class ExpressionTracker {
  constructor(profile = 'wave') { this.setProfile(profile); this.reset(); }

  setProfile(name) { this.profileName = MOTION_PROFILES[name] ? name : 'wave'; this.profile = MOTION_PROFILES[this.profileName]; }

  reset() {
    this.energy = 0.5;
    this.speed = 0;
    this.size = null;
    this.box = null;
    this._samples = [];     // [{ t, size, speed }]：包絡的歷史（個人範圍）
    this._recent = [];      // [{ t, size, speed }]：最近 ENVELOPE_MS 的瞬間值（算包絡）
    this._lastSampleMs = -Infinity;
    this._lastMs = null;
    this._lastWrist = null;
  }

  /**
   * 餵一幀。回傳 { energy, box, size, speed, rel }；這一幀沒有可用的骨架時 energy 照舊（慢慢回到中性）、box 為 null。
   * @param {object|null} track  tracking.js 的 track（smoothed、scale、aspect）
   * @param {number} nowMs
   */
  update(track, nowMs) {
    const dt = this._lastMs === null ? 0 : Math.min(200, Math.max(0, nowMs - this._lastMs));
    this._lastMs = nowMs;
    const f = track ? boxFeatures(track) : null;
    if (!f) {
      this.box = null;
      this._lastWrist = null;
      if (dt) this.energy += (0.5 - this.energy) * (1 - Math.exp(-dt / 3000));   // 不在畫面：慢慢回到中性
      return { energy: this.energy, box: null, size: this.size, speed: this.speed, rel: null };
    }
    // 手的速度（尺度／秒）：兩隻手腕裡動得比較快的那一隻，EMA 平滑
    const sc = Math.max(1e-3, track.scale), lm = track.smoothed;
    let v = 0;
    if (this._lastWrist && dt > 0) {
      for (const i of WRISTS) {
        const p = lm[i], q = this._lastWrist[i];
        if (!p?.visible || !q) continue;
        v = Math.max(v, Math.hypot(p.x - q.x, (p.y - q.y) * track.aspect) / sc / (dt / 1000));
      }
      this.speed += (v - this.speed) * (1 - Math.exp(-dt / 250));
    }
    this._lastWrist = {};
    for (const i of WRISTS) if (lm[i]?.visible) this._lastWrist[i] = { x: lm[i].x, y: lm[i].y };
    this.size = f.size;
    this.box = f.box;
    // 包絡：最近 ENVELOPE_MS 內的最大框與最快手速
    this._recent.push({ t: nowMs, size: f.size, speed: this.speed });
    while (this._recent.length && nowMs - this._recent[0].t > ENVELOPE_MS) this._recent.shift();
    let envSize = 0, envSpeed = 0;
    for (const r of this._recent) { if (r.size > envSize) envSize = r.size; if (r.speed > envSpeed) envSpeed = r.speed; }
    // 個人範圍（包絡的歷史）
    if (nowMs - this._lastSampleMs >= SAMPLE_MS) {
      this._lastSampleMs = nowMs;
      this._samples.push({ t: nowMs, size: envSize, speed: envSpeed });
      while (this._samples.length && nowMs - this._samples[0].t > HISTORY_MS) this._samples.shift();
    }
    const sizes = this._samples.map((s) => s.size), speeds = this._samples.map((s) => s.speed);
    const rel = (x, xs, minRange) => clamp01(0.5 + (x - percentile(xs, 0.5)) / Math.max(minRange, percentile(xs, 0.9) - percentile(xs, 0.1)));
    const relSize = rel(envSize, sizes, MIN_SIZE_RANGE), relSpeed = rel(envSpeed, speeds, MIN_SPEED_RANGE);
    // 絕對值：手放下、站著的框大約 1.5～2 個尺度；雙手張開舉高約 3.5 以上。手速 5 尺度／秒算很快
    const absSize = clamp01((envSize - 1.8) / 2.2), absSpeed = clamp01(envSpeed / 5);
    const P = this.profile, a = P.absWeight;
    const raw = P.size * ((1 - a) * relSize + a * absSize) + P.speed * ((1 - a) * relSpeed + a * absSpeed);
    // 樣本太少（剛進鏡頭）時還不知道他的範圍：往中性靠
    const conf = Math.min(1, this._samples.length / 20);
    const target = 0.5 + (raw - 0.5) * conf;
    if (dt) this.energy += (target - this.energy) * (1 - Math.exp(-dt / P.tauMs));
    return { energy: this.energy, box: f.box, size: envSize, speed: envSpeed, rel: relSize };
  }
}
