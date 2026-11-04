// sim.js — 用 Node 驅動排程器：假合成器記下每一次呼叫，12ms 一次 tick（跟 midiPlayer.js 一樣），AudioContext 時間＝模擬時間。
// 演奏者用「機器人」模擬：照排程器自己公布的下一個要按的起音（跟畫面上給演奏者看的是同一份資料）在樂譜時刻按，可加速度倍率、手抖、漏按、亂按。

import { Scheduler } from '../../src/midi/scheduler.js';
import { rng } from './songs.js';
import { beatLines as beatLinesOf } from '../../src/midi/beats.js';

export const TICK_MS = 12;
const lagOf = (slot) => (slot === 'kb' ? 2 : 110);

/** 假合成器：記下每一次呼叫（排程器時鐘 at、AudioContext 時間戳 time、是不是在 trigger() 呼叫裡） */
export class FakeSynth {
  constructor(kind, sim) { this.kind = kind; this.sim = sim; this.calls = []; }
  _rec(type, ch, a, b, opts) {
    this.calls.push({ kind: this.kind, type, ch, a, b, time: opts?.time, at: this.sim.now, inTrigger: this.sim.inTrigger, seq: this.sim.seq++ });
  }
  noteOn(ch, pitch, vel, opts) { this._rec('noteOn', ch, pitch, vel, opts); }
  noteOff(ch, pitch, opts) { this._rec('noteOff', ch, pitch, null, opts); }
  controllerChange(ch, cc, v, opts) { this._rec('cc', ch, cc, v, opts); }
  programChange(ch, p, opts) { this._rec('program', ch, p, null, opts); }
  pitchWheel(ch, v, opts) { this._rec('bend', ch, v, null, opts); }
  channelPressure(ch, v, opts) { this._rec('pressure', ch, v, null, opts); }
  polyPressure(ch, p, v, opts) { this._rec('poly', ch, p, v, opts); }
  systemExclusive(data, _o, opts) { this._rec('sysex', null, data, null, opts); }
  reset() { this._rec('reset'); }
}

/**
 * 建一個模擬：載入 score、指派 assignments（[單位 id, 槽位][]）、開始播放。
 * @returns {Sim}
 */
export function createSim(score, assignments, { startMs = 1000, config, modes } = {}) {
  return new Sim(score, assignments, { startMs, config, modes });
}

export class Sim {
  constructor(score, assignments, { startMs, config, modes }) {
    this.now = startMs;
    this.seq = 0;
    this.inTrigger = false;
    this.sched = new Scheduler(config);
    this.assist = new FakeSynth('assist', this);
    this.human = new FakeSynth('human', this);
    this.sched.setSynths(this.assist, this.human);
    this.sched.enableEventLog();
    this.events = [];
    for (const type of ['press', 'release', 'leader', 'performer', 'chase', 'autoRelease', 'group', 'stall', 'finish', 'noteOn', 'noteOff', 'mode', 'hint']) {
      this.sched.events.on(type, (e) => this.events.push({ type, ...e, simMs: this.now }));
    }
    this.sched.load(score, assignments);
    if (modes) for (const [slot, mode] of Object.entries(modes)) this.sched.setMode?.(isNaN(slot) ? slot : Number(slot), mode);
    this.score = score;
    this.startMs = startMs;
    this.sched.play();
    this.bots = [];
    this.triggers = [];   // { slot, atMs, released, noteOns }
  }

  get audioNow() { return this.now / 1000; }

  /** 往前推到 toMs，期間每 12ms 一個 tick，並讓機器人在該按的時刻按 */
  advance(toMs) {
    while (this.now < toMs) {
      const next = Math.min(toMs, this.now + TICK_MS);
      // 機器人的按鍵落在 tick 之間：先推到按鍵時刻再按（trigger 用自己的 receivedMs）
      for (;;) {
        let due = null;
        // 機器人的時刻是他的動作時刻；程式收到的時刻晚 lag（揮手要等手回升才確認，約 110ms；鍵盤 2ms），motionLagMs 預設值就是這個差
        for (const b of this.bots) { const t0 = b.nextAt(this); const t = t0 === null ? null : Math.max(this.now, t0 + (b.lagMs ?? lagOf(b.slot))); if (t !== null && t <= next && (due === null || t < due.t)) due = { t, b }; }
        if (!due) break;
        this.now = Math.max(this.now, due.t);
        due.b.fire(this);
      }
      this.now = next;
      for (const b of this.bots) if (b.idle && b.nextAt(this) === null) b.idle(this);
      this.sched.tick(this.now, this.audioNow);
    }
  }

  /** 觸發一次（輸入事件）；回傳放行與否、這次呼叫裡送出的你的 noteOn */
  press(slot, { source = slot === 'kb' ? 'keyboard' : 'gesture', key = source === 'keyboard' ? 'KeyF' : undefined, motionLagMs = source === 'gesture' ? 110 : 2, intensity } = {}) {
    const before = this.human.calls.length, beforeA = this.assist.calls.length;
    this.inTrigger = true;
    const ev = { slot, source, eventTimeMs: this.now - motionLagMs, receivedMs: this.now };
    if (key !== undefined) ev.key = key;
    if (intensity !== undefined) ev.intensity = intensity;
    let released;
    try { released = this.sched.trigger(ev); } finally { this.inTrigger = false; }
    const noteOns = this.human.calls.slice(before).filter((c) => c.type === 'noteOn');
    const assistOns = this.assist.calls.slice(beforeA).filter((c) => c.type === 'noteOn');
    const rec = { slot, atMs: this.now, released, noteOns, assistOns, key };
    this.triggers.push(rec);
    return rec;
  }

  lift(slot, key) {
    this.sched.lift({ slot, key, source: 'keyboard', eventTimeMs: this.now, receivedMs: this.now });
  }

  addBot(bot) { this.bots.push(bot); return bot; }

  /** 跑到播完或 maxMs */
  runToEnd(maxMs = 600000) {
    const limit = this.startMs + maxMs;
    while (this.now < limit && !this.sched.isFinished()) this.advance(this.now + 120);
    return this.sched.isFinished();
  }

  /** 實際發聲時刻（ms）：帶時間戳的照時間戳，否則照送出的時刻 */
  static soundMs(c) { return c.time !== undefined ? Math.max(c.time * 1000, c.at) : c.at; }

  noteOns(kind) { return (kind === 'human' ? this.human : this.assist).calls.filter((c) => c.type === 'noteOn'); }
  ofType(type) { return this.events.filter((e) => e.type === type); }
}

/**
 * 閉迴路的演奏者機器人：每次都看排程器公布的「下一下要按的起音」，在它的樂譜時刻（÷ 速度倍率、加手抖）按下去。
 * 樂譜時刻以「第一下」為原點：第一下在合奏走到他的入場點時按（排程器的 stall 事件之後 reactMs，或照樂譜時刻）。
 * opts：factor 速度倍率、jitterMs 手抖（均勻 ±）、miss 漏按機率、extra 多按機率（多按一下在 extraGapMs 後）、
 *       stopAtSec/resumeAtSec 在這段樂譜秒停手（離開）、source、key、seed、holdMs（keyup 模式按住多久，預設到下一下前）
 */
export function scoreBot(slot, opts = {}) {
  const { factor = 1, jitterMs = 0, miss = 0, extra = 0, extraGapMs = 40, source = slot === 'kb' ? 'keyboard' : 'gesture', seed = 3, stopAtMs = null, resumeAtMs = null, key = null, lagFromStart = 0, alt = true, retryMs = 300 } = opts;
  const r = rng(seed);
  const keys = ['KeyF', 'KeyJ', 'KeyD', 'KeyK'];
  let planned = null;       // { index, at }
  let extraAt = null;
  let lastKey = null;
  let keyIdx = 0;
  let lastPress = null;     // { ms, sec, head }：上一次按下去放出的起音
  let lastFired = null;     // { index, at }：上一次按的是哪個起音
  let delayed = null;       // 漏按的那個起音 index：下一次改在它後面那個起音的時刻按
  const bot = {
    slot, presses: 0, misses: 0, lastPressMs: -Infinity,
    // 沒有下一下要按（彈完、停手）時，按著的鍵在一段時間後放開（keyup 模式不放開音會一直響）
    idle(sim) { if (lastKey && sim.now - this.lastPressMs > 800) { sim.lift(slot, lastKey); lastKey = null; } },
    group(sim) { return sim.sched.inspect().groups.find((g) => g.slot === slot); },
    nextIndex(sim, g) { return sim.sched.nextPressIndex ? sim.sched.nextPressIndex(slot) : g.groupEnd; },
    nextAt(sim) {
      if (extraAt !== null) return extraAt;
      const g = this.group(sim);
      if (!g) return null;
      const idx = this.nextIndex(sim, g);
      if (idx === null || idx >= g.segments.length) return null;
      if (planned && planned.index === idx) return planned.at;
      // 代打中游標是電腦推的：他照自己的拍子按下去（可能剛好在電腦替他放之後一點點＝接手），不因游標被推走就一直往後重排
      if (planned && g.status === 'substitute' && planned.at + 200 >= sim.now) return planned.at;   // 200：動作到程式收到之間的延遲（揮手 110ms）還沒過
      // 上一下按了卻沒有往前（被去抖擋、被鎖成預按）：同一個起音隔 retryMs 再試，跟真人一樣不會在同一毫秒狂按
      if (lastFired && lastFired.index === idx) { planned = { index: idx, at: lastFired.at + retryMs }; return planned.at; }
      const ref = delayed === idx && g.segments[idx + 1] ? idx + 1 : idx;
      if (delayed !== idx) delayed = null;
      const sec = sim.score.midiTicksToSeconds(g.segments[ref].ticks);
      // 照自己的速度、從自己上一下接著數（跟真人一樣：被合奏拉走之後從新的位置繼续，不回頭照開場的時間表）
      const base = g.lastHead !== null && lastPress ? lastPress : { ms: sim.startMs + lagFromStart, sec: 0 };
      if (g.lastHead !== null && lastPress && g.lastHead !== lastPress.head) {
        // 他上一下之後被合奏跳過去（落後跳、代打）：以放出來的位置為準
        base.sec = sim.score.midiTicksToSeconds(g.segments[g.lastHead].ticks);
      }
      let at = base.ms + ((sec - base.sec) * 1000) / factor + (r() * 2 - 1) * jitterMs;
      if (stopAtMs !== null && at >= stopAtMs && (resumeAtMs === null || at < resumeAtMs)) at = resumeAtMs ?? Infinity;
      if (at === Infinity) return null;
      planned = { index: idx, at };
      return planned.at;
    },
    fire(sim) {
      if (extraAt !== null) { extraAt = null; sim.press(slot, { source, key: source === 'keyboard' ? 'KeyL' : undefined }); return; }
      const idx = planned.index;
      planned = null;
      lastFired = { index: idx, at: sim.now };
      if (delayed !== idx && r() < miss) { delayed = idx; this.misses++; return; }
      delayed = null;
      let k;
      if (source === 'keyboard') {
        k = key ?? (alt ? keys[keyIdx++ % keys.length] : 'KeyF');
        if (lastKey) sim.lift(slot, lastKey);
        lastKey = k;
      }
      sim.press(slot, { source, key: k });
      this.lastPressMs = sim.now;
      const after = this.group(sim);
      if (after.lastHead !== null) lastPress = { ms: sim.now, sec: sim.score.midiTicksToSeconds(after.segments[after.lastHead].ticks), head: after.lastHead };
      this.presses++;
      if (r() < extra) extraAt = sim.now + extraGapMs;
    },
  };
  return bot;
}

/** 亂按：從 fromMs 到 toMs 每 periodMs±jitter 按一下，不看樂譜 */
export function mashBot(slot, { fromMs, toMs, periodMs = 90, jitter = 0.5, source = slot === 'kb' ? 'keyboard' : 'gesture', seed = 11 } = {}) {
  const r = rng(seed);
  let at = fromMs;
  return {
    slot, presses: 0,
    nextAt() { return at <= toMs ? at : null; },
    fire(sim) {
      sim.press(slot, { source, key: source === 'keyboard' ? ['KeyA', 'KeyS', 'KeyD'][this.presses % 3] : undefined });
      this.presses++;
      at = sim.now + periodMs * (1 + (r() * 2 - 1) * jitter);
    },
  };
}

/** 指派表：單位 id（依 parts 順序）→ 槽位 */
export function assign(score, slots) {
  return score.parts.map((p, i) => [p.id, slots[i]]).filter(([, s]) => s !== undefined && s !== null);
}

/**
 * 跟著拍子揮的人（不懂音樂、不看音符）：從他第一個音所在的那一拍起，每一條拍線（beats.js）都按一下，速度倍率 factor、手抖 jitterMs。
 * 不看排程器的狀態（開迴路）：他只是跟著拍子。
 */
export function beatBot(slot, { factor = 1, jitterMs = 0, seed = 21, source = slot === 'kb' ? 'keyboard' : 'gesture', fromLine = null } = {}) {
  const r = rng(seed);
  let times = null, i = 0, lastKey = null, extra = 0;
  return {
    slot, presses: 0,
    _init(sim) {
      const { lines } = beatLinesOf(sim.score);
      const g = sim.sched.inspect().groups.find((x) => x.slot === slot);
      const first = g.segments[0]?.ticks ?? 0;
      let k = fromLine ?? Math.max(0, lines.findIndex((t, n) => t <= first && (lines[n + 1] ?? Infinity) > first));
      times = lines.slice(k).map((t) => sim.startMs + (sim.score.midiTicksToSeconds(t) * 1000) / factor + (r() * 2 - 1) * jitterMs);
    },
    nextAt(sim) {
      if (!times) this._init(sim);
      // 拍線用完了但還沒奏完（中間有一下被擋、慢了一拍）：真人會照同樣的拍子繼續揮到音樂結束，最多多揮 8 下
      if (i >= times.length && times.length >= 2 && extra < 8 && !sim.sched.isFinished()) {
        const g = sim.sched.inspect().groups.find((x) => x.slot === slot);
        if (g.groupEnd < g.segments.length || g.credit) { times.push(times.at(-1) + (times.at(-1) - times.at(-2))); extra++; }
      }
      return i < times.length ? times[i] : null;
    },
    idle(sim) { if (lastKey && i >= times.length) { sim.lift(slot, lastKey); lastKey = null; } },
    fire(sim) {
      i++;
      const key = source === 'keyboard' ? ['KeyF', 'KeyJ'][this.presses % 2] : undefined;
      if (lastKey) sim.lift(slot, lastKey);
      sim.press(slot, { source, key });
      lastKey = key ?? null;
      this.presses++;
    },
  };
}

/** 照著自己聲部每個音按的人（開迴路，照樂譜時刻 ÷ factor），相鄰太近（< minGapMs）的音只按第一個 */
export function onsetBot(slot, { factor = 1, jitterMs = 0, seed = 31, minGapMs = 150, source = slot === 'kb' ? 'keyboard' : 'gesture' } = {}) {
  const r = rng(seed);
  let times = null, i = 0, lastKey = null;
  return {
    slot, presses: 0,
    nextAt(sim) {
      if (!times) {
        const g = sim.sched.inspect().groups.find((x) => x.slot === slot);
        times = [];
        for (const s of g.segments) {
          const t = sim.startMs + (sim.score.midiTicksToSeconds(s.ticks) * 1000) / factor;
          if (!times.length || t - times.at(-1) >= minGapMs) times.push(t);
        }
        times = times.map((t) => t + (r() * 2 - 1) * jitterMs);
      }
      return i < times.length ? times[i] : null;
    },
    idle(sim) { if (lastKey && i >= times.length) { sim.lift(slot, lastKey); lastKey = null; } },
    fire(sim) {
      i++;
      const key = source === 'keyboard' ? ['KeyF', 'KeyJ'][this.presses % 2] : undefined;
      if (lastKey) sim.lift(slot, lastKey);
      sim.press(slot, { source, key });
      lastKey = key ?? null;
      this.presses++;
    },
  };
}
