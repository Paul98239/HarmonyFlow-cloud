// 防呆：模糊測試（隨機的 MIDI × 隨機的演奏者行為）、極端檔案、找到過的問題的回歸測試。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzCase } from './helpers/fuzz.js';
import { violations } from './helpers/scenarios.js';
import { buildMidi, run } from './helpers/smf.js';
import { parseMidi } from '../src/midi/midiParser.js';
import { createSim, scoreBot, assign } from './helpers/sim.js';
import { stuckNotes } from './helpers/metrics.js';

test('模糊測試（150 個隨機案例；完整的跑 node test/tools/fuzz.mjs 1 1000）：沒有例外、沒有違規', () => {
  const bad = [];
  for (let seed = 1; seed <= 150; seed++) {
    const c = fuzzCase(seed);
    c.sim.runToEnd(c.limitMs);
    let v = violations(c.sim, { finished: c.expectFinish });
    if (!c.sim.sched.isFinished()) v = v.filter((x) => !x.startsWith('卡音'));
    if (v.length) bad.push(`種子 ${seed}：${v.join('；')}`);
  }
  assert.deepEqual(bad, []);
});

test('回歸：沒有人帶頭、合奏跟著代打中的人時，伴奏 hold 著的音照樣收得掉（原本會永遠響）', () => {
  // 鍵盤手的聲部很短（先彈完），演奏者 1 從沒來（代打）；伴奏是連奏，每顆音的結尾接著演奏者 1 的起音（hold）
  const Q = 480;
  const kb = run(0, 4, Q, [72, 74, 76, 77]);
  const p1 = run(0, 24, Q, [60, 62, 64]);
  const acc = run(0, 24, Q, [48, 50, 52], { dur: Q });
  const score = parseMidi(buildMidi({ tempos: [{ tick: 0, bpm: 110 }], timeSigs: [{ tick: 0, num: 4, den: 4 }], parts: [{ notes: kb }, { notes: p1 }, { program: 48, notes: acc }] }));
  const sim = createSim(score, assign(score, ['kb', 1]));
  sim.sched.setPresence([], sim.now);
  sim.addBot(scoreBot('kb', { jitterMs: 5 }));
  assert.ok(sim.runToEnd(60000), '要奏完');
  assert.deepEqual(stuckNotes(sim), []);
});

test('帶頭的人離開鏡頭、沒有別人可以接：電腦代打、合奏照樂譜走完；回來揮一下就接回去', () => {
  const Q = 480;
  const score = parseMidi(buildMidi({ tempos: [{ tick: 0, bpm: 100 }], timeSigs: [{ tick: 0, num: 4, den: 4 }], parts: [{ notes: run(0, 40, Q, [60, 64, 67]) }, { program: 32, notes: run(0, 20, 2 * Q, [36, 43]) }] }));
  const sim = createSim(score, assign(score, [1]));
  sim.sched.setPresence([1], sim.now);
  const bot = sim.addBot(scoreBot(1, { jitterMs: 10, stopAtMs: 6000, resumeAtMs: 14000 }));
  sim.advance(6200);
  sim.sched.setPresence([], sim.now);   // 走出鏡頭
  sim.advance(10000);
  assert.equal(sim.sched.viewState().performers[0].state, 'substitute');
  const pos1 = sim.sched.viewState().positionSec;
  sim.advance(12000);
  assert.ok(sim.sched.viewState().positionSec > pos1 + 1, '代打時合奏照樂譜往前走');
  sim.sched.setPresence([1], sim.now);  // 回來
  sim.runToEnd(60000);
  assert.ok(sim.sched.isFinished());
  assert.ok(sim.ofType('press').some((e) => e.slot === 1 && e.simMs > 14000 && ['released', 'takeover'].includes(e.result)), '回來之後接回去');
  void bot;
});

test('極端的檔案：10 萬顆音的檔案載入（解析＋演奏計畫）在合理時間內；空的、只有鼓、0 長度的音都不會壞', async () => {
  const notes = [];
  for (let i = 0; i < 100000; i++) notes.push({ tick: i * 20, dur: 15, pitch: 40 + (i % 50) });
  const t0 = performance.now();
  const score = parseMidi(buildMidi({ ppq: 480, parts: [{ notes: notes.slice(0, 50000) }, { notes: notes.slice(50000) }] }));
  const sim = createSim(score, assign(score, ['kb']));
  const ms = performance.now() - t0;
  assert.ok(ms < 4000, `花了 ${ms.toFixed(0)}ms`);
  sim.press('kb');
  sim.advance(sim.now + 2000);
  for (const spec of [
    { parts: [{ notes: [{ tick: 0, dur: 0, pitch: 60 }] }] },
    { parts: [{ channel: 9, notes: run(0, 16, 240, [36, 38, 42]) }] },
    { tempos: [{ tick: 0, bpm: 300 }, { tick: 480, bpm: 20 }], parts: [{ notes: run(0, 8, 480, [60], { dur: 0 }) }] },
  ]) {
    const s2 = parseMidi(buildMidi(spec));
    const sim2 = createSim(s2, assign(s2, [1]));
    sim2.addBot(scoreBot(1, { jitterMs: 5 }));
    sim2.runToEnd(60000);
    assert.deepEqual(violations(sim2), [], JSON.stringify(spec).slice(0, 80));
  }
});
