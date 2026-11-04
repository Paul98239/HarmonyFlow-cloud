// beats.js — 拍子層的「拍」：一首歌的拍線（tick），與每位演奏者「一下帶一拍」的單位。純函式，載入／改指派時算一次。
//
// 拍線從哪裡來：
//  · 檔案有四分音符（PPQ）而且音符真的落在拍號格線上（fitsGrid）：用拍號格線（timeline.js 的 buildBeatGrid，複拍子依 cc 換算成附點拍）。
//    一拍太短（快歌、5/8 這類以八分音符為拍）就在小節內兩兩（或三三）合併；一拍太長（慢板、2/2）就均分。
//  · 否則（SMPTE 沒有四分音符；未量化的錄製檔、速度表沒照實際演奏寫，音符不落在格線上）：從全曲起音的時刻估一個脈動（estimatePulse），
//    再沿著起音一拍一拍往前找（trackBeats）：拍線盡量落在真的有音的地方，找不到就照脈動往前推。
//  · 弱起不用特別處理：格線從 tick 0 起算，弱起的音落在它真正的拍上；脈動從第一個起音起算。
//
// 演奏者的單位：他的每個起音屬於「它所在的那一拍」（起音比拍線早一點點——未量化的搶拍——也算那一拍）；一個單位＝同一拍裡他的所有起音，
// 單位的頭一定是他自己的起音，所以按下去一定當下有聲音（不會按在一拍的開頭、音卻在半拍之後才出來）。整拍都沒有他的音的拍不需要按。

import { buildBeatGrid } from './timeline.js';

// 應用層數字（不是規格）：
export const BEAT_MIN_SEC = 0.36;     // 拍線間隔（原速）短於這個就合併：0.36 秒 ≈ 167 BPM，再快一般人揮不過來
export const BEAT_MAX_SEC = 1.25;     // 拍線間隔長於這個就均分：一下自動放的音最多大約這麼久（慢板 40 BPM 的二分音符拍是 3 秒）
const GRID_FIT_TOL_BEATS = 0.06;      // 起音離拍線不到這麼多拍算「落在拍上」
const GRID_FIT_MIN = 0.45;            // 有音的拍裡，拍線上真的有起音的比例至少這麼多，才相信拍號格線（未量化的錄製檔約 0.1～0.2）
const ONSET_MERGE_SEC = 0.05;         // 估脈動時，相差不到這麼多的起音算同一個（和弦錯位、裝飾音）
const EARLY_TOL = 0.15;               // 起音比拍線早不到「這一拍的這麼多」也算那一拍（搶拍）

const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };
const upperBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; };

/** 拍號格線合不合：有音的拍裡，拍線上（±GRID_FIT_TOL_BEATS 拍）真的有起音的比例 */
export function gridFit(score, beats) {
  const onsets = [...new Set(score.notes.map((n) => n.startTick))].sort((a, b) => a - b);
  if (!onsets.length || !beats.length) return 0;
  let withNotes = 0, onLine = 0;
  for (const b of beats) {
    const len = b.endTick - b.startTick;
    const i = lowerBound(onsets, b.startTick - len * GRID_FIT_TOL_BEATS);
    if (i >= onsets.length || onsets[i] >= b.endTick) continue;   // 這一拍沒有任何音（休止、曲尾）不算
    withNotes++;
    if (onsets[i] <= b.startTick + len * GRID_FIT_TOL_BEATS) onLine++;
  }
  return withNotes ? onLine / withNotes : 0;
}

// 一小節 n 拍、每拍太短時怎麼兩兩／三三合併（5 → 2+3、7 → 2+2+3、9 → 3+3+3）
function groupSizes(n) {
  if (n <= 3) return [n];
  if (n % 2 === 0 && n % 3 !== 0) return Array(n / 2).fill(2);
  if (n % 3 === 0) return Array(n / 3).fill(3);
  return [...Array((n - 3) / 2).fill(2), 3];
}

// 拍號格線 → 拍線（合併太短的、均分太長的）
function linesFromGrid(score, beats) {
  const sec = (t) => score.midiTicksToSeconds(t);
  const lines = [];
  // 依小節分組
  const byMeasure = new Map();
  for (const b of beats) { if (!byMeasure.has(b.measureIndex)) byMeasure.set(b.measureIndex, []); byMeasure.get(b.measureIndex).push(b); }
  for (const bs of byMeasure.values()) {
    const short = bs.length > 1 && bs.every((b) => sec(b.endTick) - sec(b.startTick) < BEAT_MIN_SEC);
    if (short) {
      let i = 0;
      for (const size of groupSizes(bs.length)) { lines.push(bs[i].startTick); i += size; }
    } else {
      for (const b of bs) lines.push(b.startTick);
    }
  }
  return lines;
}

/**
 * 從起音時刻估脈動（秒）：起音兩兩的時間差落在候選週期整數倍附近的程度（加權），乘上偏好 0.6 秒（100 BPM）一帶的先驗。
 * 只看 4 個週期以內的配對，n 個起音約 O(n × 候選數)。onsets：[{ sec, w }] 依時間排序。
 */
export function estimatePulse(onsets) {
  if (onsets.length < 3) return 0.6;
  let best = 0.6, bestScore = -Infinity;
  for (let P = 0.3; P <= 1.5; P += 0.005) {
    let s = 0;
    for (let i = 0; i < onsets.length; i++) {
      for (let j = i + 1; j < onsets.length; j++) {
        const d = onsets[j].sec - onsets[i].sec;
        if (d > 4 * P) break;
        const r = d / P, k = Math.round(r);
        if (k < 1) continue;
        s += (onsets[i].w * onsets[j].w * Math.exp(-((r - k) ** 2) / (2 * 0.05 ** 2))) / k;
      }
    }
    s *= Math.exp(-(Math.log2(P / 0.6) ** 2) / (2 * 0.8 ** 2));
    if (s > bestScore) { bestScore = s; best = P; }
  }
  return best;
}

/**
 * 沿著起音找拍（秒）：從第一個起音起，下一拍在「上一拍 + 週期」附近（±25%）找最像的起音（離預期越近、越重越好），找到就落在它上面、週期微調；
 * 找不到就照週期往前推。週期只在估計值的 0.75～1.33 倍之間變（跟著 rubato 走，但不會漂到別的層級）。
 */
export function trackBeats(onsets, period) {
  if (!onsets.length) return [];
  const out = [onsets[0].sec];
  const last = onsets.at(-1).sec;
  let t = onsets[0].sec, P = period;
  let i = 0;
  while (t < last - 0.25 * P) {
    const target = t + P;
    while (i < onsets.length && onsets[i].sec <= t + 0.6 * P) i++;
    let pick = null, pickScore = 0;
    for (let k = i; k < onsets.length && onsets[k].sec <= t + 1.25 * P; k++) {
      if (onsets[k].sec < t + 0.75 * P) continue;
      const sc = onsets[k].w * Math.exp(-(((onsets[k].sec - target) / (0.12 * P)) ** 2));
      if (sc > pickScore) { pickScore = sc; pick = onsets[k]; }
    }
    const next = pick && pickScore > 0.05 ? pick.sec : target;
    if (pick && pickScore > 0.05) P = Math.min(period * 1.33, Math.max(period * 0.75, 0.8 * P + 0.2 * (next - t)));
    out.push(next);
    t = next;
  }
  return out;
}

// 拍線太長的均分（tick）：每段原速秒數都不超過 BEAT_MAX_SEC
function splitLong(score, lines, endTick) {
  const sec = (t) => score.midiTicksToSeconds(t);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i], b = i + 1 < lines.length ? lines[i + 1] : endTick;
    out.push(a);
    const dur = sec(b) - sec(a);
    if (!(b > a) || dur <= BEAT_MAX_SEC) continue;
    const k = Math.ceil(dur / BEAT_MAX_SEC);
    for (let m = 1; m < k; m++) out.push(score.secondsToMIDITicks(sec(a) + (dur * m) / k));
  }
  return out;
}

const cache = new WeakMap();

/**
 * 這首歌的拍線。{ lines: 拍線 tick（遞增）, source: 'grid'｜'pulse', periodSec: 脈動（只有 pulse 有）, fit: 格線吻合度 }。同一份樂譜只算一次。
 */
export function beatLines(score) {
  if (cache.has(score)) return cache.get(score);
  const endTick = Math.max(score.durationTicks, (score.notes.at(-1)?.endTick ?? 0));
  let result;
  const grid = score.timeDivision ? buildBeatGrid({ ...score, warnings: [] }) : [];
  const fit = grid.length ? gridFit(score, grid) : 0;
  if (grid.length && fit >= GRID_FIT_MIN) {
    result = { lines: linesFromGrid(score, grid), source: 'grid', periodSec: null, fit };
  } else {
    // 起音（秒）合併成「事件」，權重＝音數（壓縮過的）×平均力度
    const raw = score.notes.map((n) => ({ sec: score.midiTicksToSeconds(n.startTick), v: n.velocity })).sort((a, b) => a.sec - b.sec);
    const onsets = [];
    for (const o of raw) {
      const last = onsets.at(-1);
      if (last && o.sec - last.sec < ONSET_MERGE_SEC) { last.n++; last.v += o.v; continue; }
      onsets.push({ sec: o.sec, n: 1, v: o.v });
    }
    for (const o of onsets) o.w = Math.sqrt(o.n) * (0.5 + o.v / o.n / 254);
    const periodSec = Math.min(BEAT_MAX_SEC, Math.max(BEAT_MIN_SEC, estimatePulse(onsets)));
    const secs = trackBeats(onsets, periodSec);
    const lines = [...new Set(secs.map((s) => Math.round(score.secondsToMIDITicks(s))))].sort((a, b) => a - b);
    result = { lines, source: 'pulse', periodSec, fit };
  }
  result.lines = splitLong(score, result.lines, endTick).map((t) => Math.round(t));
  result.lines = [...new Set(result.lines)].sort((a, b) => a - b);
  cache.set(score, result);
  return result;
}

/**
 * 一位演奏者的拍子單位：unitOf[j]＝第 j 個起音屬於第幾條拍線（同一個值＝同一下）。脈動來源的拍線：起音比拍線早不到這一拍的 EARLY_TOL 也算那一拍。
 * 第一條拍線之前的起音（不會發生在格線，脈動從第一個起音起算）算第 0 拍。
 */
export function beatUnitsFor(score, driverTicks) {
  const { lines, source } = beatLines(score);
  const early = source === 'pulse' ? EARLY_TOL : 0;   // 格線上的音是量化過的，不需要搶拍容差（不然三十二分音符的弱起會被算進下一拍）
  const unitOf = new Array(driverTicks.length);
  for (let j = 0; j < driverTicks.length; j++) {
    const t = driverTicks[j];
    let b = Math.max(0, upperBound(lines, t) - 1);
    const next = lines[b + 1];
    if (next !== undefined) {
      const len = next - lines[b];
      if (next - t <= len * early) b++;
    }
    unitOf[j] = b;
  }
  return unitOf;
}

/** 每個起音所在那一拍的拍線 tick（unitOf 對到 beatLines().lines）：拍子模式判斷「這一下是不是在下一拍」時，比的是拍線，不是那一拍裡他的第一個音（切分音在拍線之後） */
export function unitLineTicks(score, unitOf) {
  const { lines } = beatLines(score);
  return unitOf.map((b) => lines[b] ?? 0);
}
