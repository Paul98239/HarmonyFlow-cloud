// modeAdvisor.js — 智能切換：依演奏者最近的按法，判斷他適合哪一層（音樂家／起音／拍子），給建議或（設定為「自動」時）直接切換。純邏輯，不碰排程器狀態。
//
// 由難到易：musician（音樂家）→ onset（起音）→ beat（拍子）。主控權在演奏者：
//  · 只有「自動」才會切換；選了固定的模式只給建議（畫面顯示），不動他的設定。
//  · 自動只會「往容易」切（跟不上、亂按、只照拍子按），以及拍子 → 起音（他明顯在照每個音按）；不會自動升到音樂家（只建議）：音樂家模式幾乎不擋連按，
//    對不熟的人太容易出錯，這一步要由人決定。
//  · 切換只在按鍵之間生效（下一下才照新的模式放），切完至少 SETTLE_PRESSES 下、SETTLE_MS 之內不再切，不會來回跳。
//
// 訊號（都只看他自己、跟曲子的節奏比，任何 MIDI 都一樣算）：
//  · mash（亂按／連按）：最近 MASH_WINDOW 次嘗試裡被去抖擋掉的比例 ≥ MASH_BLOCKED_RATIO，或按鍵間隔的中位數 < MASH_INTERVAL_MS 而他的速度已經被推到
//    檔案的 MASH_RATE 倍以上（起音模式的去抖會跟著連按縮小，亂按不一定被擋，而是整首越跑越快）→ 往容易切到拍子。
//  · lost（跟不上）：進入代打，或最近 LOST_WINDOW 下放行裡落後跳 ≥ LOST_JUMPS 次 → 往容易切一層。
//  · pulse（只照拍子按）：起音模式下，最近 PULSE_WINDOW 下按鍵間隔很平均（變異係數 < PULSE_PRESS_CV），他放出來的樂譜間隔卻很不平均（> PULSE_SCORE_CV）
//    → 他是照一個穩定的拍子在按，不是照音符的節奏 → 拍子模式適合他（切了之後一下帶一拍，快音也都會出來）。
//  · rhythm（照每個音按）：拍子模式下，他在一拍中間按、而且按在電腦正要替他放的那個組內音附近（ONSET_HIT_MS）的次數，最近 RHYTHM_WINDOW 次裡 ≥ RHYTHM_HITS
//    → 他想自己彈每個音 → 起音模式。
//  · steady（很穩）：起音模式下最近 STEADY_WINDOW 下都沒落後跳、沒被擋、|x| 在稍快稍慢以內 → 建議音樂家（不自動切）。

export const MODES = Object.freeze(['musician', 'onset', 'beat']);
export const MODE_LABELS = Object.freeze({ auto: '自動', musician: '音樂家', onset: '起音', beat: '拍子' });

const A = Object.freeze({
  MASH_WINDOW: 10, MASH_BLOCKED_RATIO: 0.4, MASH_MIN_ATTEMPTS: 6, MASH_INTERVAL_MS: 200, MASH_RATE: 2,
  LOST_WINDOW: 8, LOST_JUMPS: 2,
  PULSE_WINDOW: 10, PULSE_PRESS_CV: 0.18, PULSE_SCORE_CV: 0.3,
  RHYTHM_WINDOW: 8, RHYTHM_HITS: 5,
  STEADY_WINDOW: 24,
  SETTLE_PRESSES: 8, SETTLE_MS: 6000,
});
export const ADVISOR = A;

const easier = (m) => (m === 'musician' ? 'onset' : 'beat');
const cv = (xs) => {
  if (xs.length < 2) return Infinity;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!(mean > 0)) return Infinity;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) / mean;
};

export class ModeAdvisor {
  constructor() { this.reset(); }

  reset() {
    this.attempts = [];   // 最近的按鍵嘗試：{ ms, result }
    this.releases = [];   // 最近的放行：{ ms, scoreSec, jumped, zone, onsetHit }
    this.hits = [];       // 拍子模式下「在拍中間按」的那幾下：true＝按在組內音附近
    this.lastSwitch = { ms: -Infinity, presses: 0 };
    this.pressesSinceSwitch = Infinity;
    this.substituted = false;
    this.suggestion = null;   // { mode, reason }
  }

  /** 換了模式（不管是誰換的）：訊號從頭累積，切換之後的冷卻從這一刻算 */
  switched(ms) {
    this.attempts = [];
    this.releases = [];
    this.hits = [];
    this.substituted = false;
    this.lastSwitch = { ms };
    this.pressesSinceSwitch = 0;
    this.suggestion = null;
  }

  /**
   * 記一次按鍵嘗試。e：{ ms（動作時刻）, result（'released'｜'beat'｜'hold'｜'blocked'｜'rest'｜'ahead'｜'prelude'｜'takeover'｜'late'）, jumped, zone, scoreSec（放行的起音）, midGroup（拍子模式：按在一組中間）, onsetHit（按在組內音附近） }
   */
  observe(e) {
    this.pressesSinceSwitch++;
    this.attempts.push({ ms: e.ms, result: e.result, rate: e.rate ?? 1 });
    if (this.attempts.length > 32) this.attempts.shift();
    if (e.result === 'released' || e.result === 'takeover' || e.result === 'beat') {
      this.releases.push({ ms: e.ms, scoreSec: e.scoreSec, jumped: !!e.jumped, zone: e.zone ?? 'sync' });
      if (this.releases.length > 32) this.releases.shift();
    }
    if (e.midGroup) {
      this.hits.push(!!e.onsetHit);
      if (this.hits.length > 16) this.hits.shift();
    }
  }

  /** 進入代打（第二段防呆）：最強的「跟不上」訊號 */
  observeSubstitute() { this.substituted = true; }

  /**
   * 依目前的模式與設定判斷：{ switchTo: 模式｜null（只在設定為 auto 時才有）, suggestion: { mode, reason }｜null }。
   * nowMs：排程器時鐘（冷卻用）。
   */
  decide(mode, setting, nowMs) {
    const verdict = this._verdict(mode);
    this.suggestion = verdict && verdict.mode !== mode ? verdict : null;
    if (setting !== 'auto' || !this.suggestion) return { switchTo: null, suggestion: this.suggestion };
    if (this.pressesSinceSwitch < A.SETTLE_PRESSES || nowMs - this.lastSwitch.ms < A.SETTLE_MS) return { switchTo: null, suggestion: this.suggestion };
    if (verdict.mode === 'musician') return { switchTo: null, suggestion: this.suggestion };   // 不自動升到音樂家
    return { switchTo: verdict.mode, suggestion: this.suggestion };
  }

  _verdict(mode) {
    // 亂按／連按
    const att = this.attempts.slice(-A.MASH_WINDOW);
    if (att.length >= A.MASH_MIN_ATTEMPTS && mode !== 'beat') {
      const gaps = att.slice(1).map((a, i) => a.ms - att[i].ms).sort((a, b) => a - b);
      const fast = gaps[gaps.length >> 1] < A.MASH_INTERVAL_MS && att.at(-1).rate >= A.MASH_RATE;
      if (fast || att.filter((a) => a.result === 'blocked').length / att.length >= A.MASH_BLOCKED_RATIO) return { mode: 'beat', reason: 'mash' };
    }
    // 跟不上
    const rel = this.releases.slice(-A.LOST_WINDOW);
    if (mode !== 'beat' && (this.substituted || rel.filter((r) => r.jumped).length >= A.LOST_JUMPS)) return { mode: easier(mode), reason: 'lost' };
    // 起音模式：照穩定的拍子按，不照音符的節奏
    if (mode === 'onset') {
      const r = this.releases.slice(-A.PULSE_WINDOW);
      if (r.length >= A.PULSE_WINDOW && !r.some((x) => x.jumped)) {
        const press = r.slice(1).map((x, i) => x.ms - r[i].ms);
        const score = r.slice(1).map((x, i) => x.scoreSec - r[i].scoreSec);
        if (cv(press) < A.PULSE_PRESS_CV && cv(score) > A.PULSE_SCORE_CV) return { mode: 'beat', reason: 'pulse' };
      }
    }
    // 拍子模式：照每個音按
    if (mode === 'beat') {
      const h = this.hits.slice(-A.RHYTHM_WINDOW);
      if (h.length >= A.RHYTHM_WINDOW && h.filter(Boolean).length >= A.RHYTHM_HITS) return { mode: 'onset', reason: 'rhythm' };
    }
    // 起音模式很穩：建議音樂家
    if (mode === 'onset') {
      const r = this.releases.slice(-A.STEADY_WINDOW), a = this.attempts.slice(-A.STEADY_WINDOW);
      if (r.length >= A.STEADY_WINDOW && !r.some((x) => x.jumped || x.zone === 'off' || x.zone === 'lost') && !a.some((x) => x.result === 'blocked')) {
        return { mode: 'musician', reason: 'steady' };
      }
    }
    return null;
  }
}

/** 建議／切換的原因給人看的說明 */
export const REASON_TEXT = Object.freeze({
  mash: '按得很密、很多下被擋掉：一下帶一拍會比較輕鬆',
  lost: '跟不上合奏：換簡單一點的方式',
  pulse: '照著穩定的拍子在按：一下帶一拍，拍內的音由電腦照樂譜補上',
  rhythm: '照著每個音在按：可以自己放每個音',
  steady: '每一下都很準：可以試試自己掌握每個音的長短與力度',
});
