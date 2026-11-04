// scenarios.js — 合奏的情境（演奏者機器人的組合）與「絕對不能發生」的檢查，給各個測試共用。

import { loadSong, SONG_NAMES } from './songs.js';
import { createSim, scoreBot, assign } from './sim.js';
import * as M from './metrics.js';

// 兩人（PC 鍵盤手＋演奏者 1）的情境
export const DUO_SCENARIOS = {
  steady: () => [scoreBot('kb', { jitterMs: 25 }), scoreBot(1, { jitterMs: 45, seed: 9 })],
  tempoDisagree: () => [scoreBot('kb', { factor: 1.2, jitterMs: 25 }), scoreBot(1, { factor: 0.85, jitterMs: 40, seed: 9 })],
  leaderStops: () => [scoreBot('kb', { jitterMs: 20, stopAtMs: 4000, resumeAtMs: 9000 }), scoreBot(1, { jitterMs: 40, seed: 9 })],
  gestureLeaves: () => [scoreBot('kb', { jitterMs: 20 }), scoreBot(1, { jitterMs: 40, seed: 9, stopAtMs: 3500, resumeAtMs: 9000 })],
  sloppy: () => [scoreBot('kb', { jitterMs: 60, miss: 0.15, extra: 0.15 }), scoreBot(1, { jitterMs: 80, seed: 9, miss: 0.2, extra: 0.1, extraGapMs: 150 })],
  gestureFirst: () => [scoreBot(1, { jitterMs: 40, seed: 9 }), scoreBot('kb', { jitterMs: 20, lagFromStart: 1500 })],
  slowBoth: () => [scoreBot('kb', { factor: 0.6, jitterMs: 30 }), scoreBot(1, { factor: 0.65, jitterMs: 50, seed: 4 })],
};

/** 跑一個模擬並回傳違規（空陣列＝沒問題） */
export function violations(sim, { finished = true } = {}) {
  const v = [];
  if (finished && !sim.sched.isFinished()) v.push('沒有播完');
  const dl = M.delayedTriggers(sim);
  if (dl.length) v.push(`放行了卻不是當下發聲 ${dl.length} 次`);
  const bu = M.bunching(sim);
  if (bu.length) v.push(`伴奏擠成一團 ${bu.length} 處：${JSON.stringify(bu.slice(0, 2))}`);
  const la = M.leaderAlignment(sim);
  if (la.bad) v.push(`伴奏比帶頭的人晚 ${la.bad} 次（最多 ${la.worst.toFixed(0)}ms）`);
  const pp = M.leaderPingPong(sim);
  if (pp) v.push(`帶頭的人來回跳 ${pp} 次`);
  const dup = M.duplicateSounds(sim);
  if (dup.length) v.push(`同一顆音發聲兩次 ${dup.length} 顆`);
  const st = M.stuckNotes(sim);
  if (st.length) v.push(`卡音 ${st.length}`);
  return v;
}

/** 對整個測資庫跑一組指派與情境，回傳 { '歌/情境': 違規[] }（只收有違規的） */
export function sweep(slots, scenarios, { songs = SONG_NAMES, modes, maxMs = 240000, check = violations } = {}) {
  const bad = {};
  for (const name of songs) {
    const score = loadSong(name, { accompaniment: true });
    const a = assign(score, slots);
    if (a.length < slots.filter((s) => s !== null && s !== undefined).length) continue;   // 聲部不夠
    for (const [sn, mk] of Object.entries(scenarios)) {
      const sim = createSim(score, a, { modes });
      for (const b of mk()) if (a.some(([, s]) => s === b.slot)) sim.addBot(b);
      sim.runToEnd(maxMs);
      const v = check(sim);
      if (v.length) bad[`${name}/${sn}`] = v;
    }
  }
  return bad;
}
