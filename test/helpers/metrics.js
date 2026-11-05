// metrics.js — 從模擬結果量「絕對不能發生」的事：觸發不是當下發聲、伴奏擠成一團、累積落後、帶頭的人來回跳、代打交還多推一格。

import { Sim } from './sim.js';

/** 放行的觸發裡，你的音不是在這次呼叫內、不帶時間戳送出的（＝不是 0ms）；回傳違規清單 */
export function delayedTriggers(sim) {
  return sim.triggers.filter((t) => t.released && (t.noteOns.length === 0 || t.noteOns.some((c) => c.time !== undefined)));
}

/**
 * 伴奏擠成一團：依起音 tick 排序的伴奏音（追音、跳過的不算），連續三個不同起音、兩兩的「真實間隔 × 合奏當時的速度 ÷ 樂譜間隔」都小於 minRatio（＝比合奏該有的速度還擠 1/minRatio 倍以上），
 * 而且樂譜間隔至少 minScoreGapSec（和弦錯位、裝飾音本來就擠）。回傳違規清單。
 */
export function bunching(sim, { minRatio = 0.2, minScoreGapSec = 0.05 } = {}) {
  const chased = new Set(sim.ofType('chase').flatMap((e) => e.chased.map((n) => n.id)));
  const ons = sim.ofType('noteOn').filter((e) => e.kind === 'assist' && !chased.has(e.noteId));
  // 每個起音 tick 取最早發聲的時刻
  const byTick = new Map();
  const timeOf = (e) => (e.timed ? Math.max(e.dueMs, e.clockMs) : e.clockMs);
  for (const e of ons) {
    const t = e.note.startTick, ms = timeOf(e);
    if (!byTick.has(t) || ms < byTick.get(t)) byTick.set(t, ms);
  }
  const ticks = [...byTick.keys()].sort((a, b) => a - b);
  // 換帶頭的人時合奏跳到新帶頭者的位置（垂直切片：中間的音追音或跳過）是規則本身，跳點前後兩個音靠得近不算擠成一團
  const jumps = sim.ofType('leader').map((e) => e.clockMs);
  const nearJump = (ms) => jumps.some((j) => ms >= j - 1 && ms - j < 60);
  // 「擠成一團」＝連續三個以上不同的起音被壓在一起（兩兩之間都比樂譜快 1/minRatio 倍以上）。只有兩個音靠在一起的是 lookahead 的極限：
  // 帶頭的人提早按時，已經帶時間戳送出（最多 LOOKAHEAD_MS 之前）的那一顆取消不了，會緊跟在新一拍的音後面響（見 docs/DECISIONS.md），不算
  // 跟「合奏當時跟著的速度」比（最近一次錨點的速度）：帶頭的人彈得快，伴奏本來就該跟著快；擠成一團是比他的速度還擠（追趕、堆在一起）
  const anchors = sim.events.filter((e) => (e.type === 'anchor' || e.type === 'reanchor') && e.ensemble && Number.isFinite(e.rate)).map((e) => [e.clockMs, e.rate]);
  const rateAt = (ms) => { let r = 1; for (const [t, rate] of anchors) { if (t > ms + 1) break; r = rate; } return r; };
  const squeezed = (i) => {
    const ds = sim.score.midiTicksToSeconds(ticks[i]) - sim.score.midiTicksToSeconds(ticks[i - 1]);
    if (ds < minScoreGapSec) return null;
    const dr = (byTick.get(ticks[i]) - byTick.get(ticks[i - 1])) / 1000;
    const rate = Math.max(rateAt(byTick.get(ticks[i - 1])), rateAt(byTick.get(ticks[i])));
    return (dr * rate) / ds < minRatio ? { tick: ticks[i], scoreGap: ds, realGap: dr, rate } : null;
  };
  const bad = [];
  for (let i = 2; i < ticks.length; i++) {
    if (nearJump(byTick.get(ticks[i])) || nearJump(byTick.get(ticks[i - 1]))) continue;
    const a = squeezed(i - 1), b = squeezed(i);
    if (a && b) bad.push(b);
  }
  return bad;
}

/**
 * 累積落後：帶頭的人每次放行起音 T 時，伴奏在 T 上的音（同一個 tick）應該在同一刻發聲；回傳 |差| 的最大值（ms）與違規數。
 * 只看「放行時他是帶頭的人」的按鍵；只算伴奏比他晚的（伴奏比他早＝他落在合奏後面，合奏不倒退，設計如此）。
 */
export function leaderAlignment(sim, { tolMs = 15 } = {}) {
  const leaderAt = [];   // [simMs, slot]
  for (const e of sim.ofType('leader')) leaderAt.push([e.simMs, e.to]);
  const leaderOf = (ms) => { let s = null; for (const [t, to] of leaderAt) if (t <= ms) s = to; return s; };
  const assistByTick = new Map();
  for (const e of sim.ofType('noteOn')) {
    if (e.kind !== 'assist') continue;
    const ms = e.timed ? Math.max(e.dueMs, e.clockMs) : e.clockMs;
    const t = e.note.startTick;
    if (!assistByTick.has(t) || ms < assistByTick.get(t)) assistByTick.set(t, ms);
  }
  let worst = 0, bad = 0;
  for (const r of sim.ofType('release')) {
    if (leaderOf(r.simMs) !== r.slot) continue;
    const ms = assistByTick.get(r.ticks);
    if (ms === undefined) continue;
    // 伴奏比帶頭的人晚＝伴奏落後（累積落後）；伴奏比他早是他落在合奏後面（換人帶頭時合奏不倒退、停在原處等他），不算伴奏的錯
    const d = ms - r.clockMs;
    worst = Math.max(worst, d);
    if (d > tolMs) bad++;
  }
  return { worst, bad };
}

/** 帶頭的人來回跳：A→B→A，而且 B 帶不到 windowMs（＝最短帶頭時間 ENSEMBLE.LEADER_TENURE_MIN_MS）就換回 A 的次數。B 帶了一陣子、A 恢復後拿回帶頭是規則本身 */
export function leaderPingPong(sim, { windowMs = 1200 } = {}) {
  const ev = sim.ofType('leader').filter((e) => e.reason !== 'tie');   // 同時開始的排序（tie）發生在開場同一刻，不是來回跳
  let n = 0;
  for (let i = 2; i < ev.length; i++) {
    // 被迫的交棒（帶頭的人彈完、被拿掉指派、揮手沒確認、離開鏡頭、速度離群、休止交棒）不是來回跳
    if (['done', 'removed', 'unconfirmed', 'absent', 'racing', 'rest'].includes(ev[i].reason)) continue;
    if (ev[i - 1].to === null) continue;   // 中間一段是「沒有人帶頭」（暫時的人沒確認被移出名單）：不是在兩個演奏者之間跳
    if (ev[i].to === ev[i - 2].to && ev[i].to !== ev[i - 1].to && ev[i].simMs - ev[i - 1].simMs < windowMs) n++;
  }
  return n;
}

/** 每顆音恰好處理一次（發聲或跳過），沒有重複發聲 */
export function duplicateSounds(sim) {
  const seen = new Map();
  for (const e of sim.ofType('noteOn')) seen.set(e.noteId + '@' + e.staffId, (seen.get(e.noteId + '@' + e.staffId) || 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1);
}

/** 你的合成器上 noteOn 沒有配對的 noteOff（卡音） */
export function stuckNotes(sim) {
  const open = new Map();
  for (const synth of [sim.human, sim.assist]) {
    for (const c of synth.calls) {
      const k = `${synth.kind}:${c.ch}:${c.a}`;
      if (c.type === 'noteOn') open.set(k, (open.get(k) || 0) + 1);
      else if (c.type === 'noteOff' && open.get(k)) open.set(k, open.get(k) - 1);
      else if (c.type === 'cc' && (c.a === 123 || c.a === 120)) for (const key of [...open.keys()]) if (key.startsWith(`${synth.kind}:${c.ch}:`)) open.delete(key);
    }
  }
  return [...open.entries()].filter(([, n]) => n > 0);
}

export { Sim };
