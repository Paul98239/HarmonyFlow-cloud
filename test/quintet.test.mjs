// 五人合奏（PC 鍵盤手＋演奏者 1～4，PC 鍵盤手沒有骨架）：三種模式與自動、各種演奏者行為的組合，合奏規則都成立。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSong } from './helpers/songs.js';
import { createSim, scoreBot, beatBot, onsetBot, mashBot, assign } from './helpers/sim.js';
import { violations } from './helpers/scenarios.js';

const SLOTS = ['kb', 1, 2, 3, 4];
const SCENES = {
  穩定: () => SLOTS.map((s, i) => scoreBot(s, { jitterMs: 25 + 10 * i, seed: 10 + i })),
  速度各不同: () => SLOTS.map((s, i) => scoreBot(s, { factor: [1, 0.85, 1.15, 0.95, 1.05][i], jitterMs: 40, seed: 20 + i })),
  兩人離開: () => SLOTS.map((s, i) => scoreBot(s, { jitterMs: 30, seed: 30 + i, ...(i === 0 ? { stopAtMs: 6000, resumeAtMs: 12000 } : i === 3 ? { stopAtMs: 4000 } : {}) })),
  每個人都亂: () => SLOTS.map((s, i) => scoreBot(s, { jitterMs: 70, miss: 0.15, extra: 0.1, seed: 40 + i })),
  一半跟拍子: () => SLOTS.map((s, i) => (i % 2 ? beatBot(s, { jitterMs: 40, seed: 50 + i }) : scoreBot(s, { jitterMs: 30, seed: 50 + i }))),
  有人亂按: () => [mashBot('kb', { fromMs: 2000, toMs: 9000, periodMs: 90 }), onsetBot(1, { jitterMs: 20 }), beatBot(2, { jitterMs: 30 }), scoreBot(3, { jitterMs: 30 }), scoreBot(4, { jitterMs: 30 })],
  鍵盤手沒來: () => SLOTS.slice(1).map((s, i) => scoreBot(s, { jitterMs: 30, seed: 60 + i })),
};
const MODES = {
  起音: {},
  自動: Object.fromEntries(SLOTS.map((s) => [s, 'auto'])),
  混合: { kb: 'musician', 1: 'beat', 2: 'onset', 3: 'auto', 4: 'beat' },
  拍子: Object.fromEntries(SLOTS.map((s) => [s, 'beat'])),
  音樂家: Object.fromEntries(SLOTS.map((s) => [s, 'musician'])),
};

test('五人合奏：每種模式組合 × 每種演奏情境都沒有違規、每個聲部都奏完', () => {
  const bad = {};
  for (const [mn, modes] of Object.entries(MODES)) {
    for (const [sn, mk] of Object.entries(SCENES)) {
      const score = loadSong('quintet', { accompaniment: true });
      const sim = createSim(score, assign(score, SLOTS), { modes });
      for (const b of mk()) sim.addBot(b);
      sim.runToEnd(240000);
      const v = violations(sim);
      if (v.length) bad[`${mn}/${sn}`] = v;
    }
  }
  assert.deepEqual(bad, {});
});

test('五人合奏：有人亂按時不會變成帶頭的人把合奏拖著飆（三人以上才判速度離群）', () => {
  const score = loadSong('quintet', { accompaniment: true });
  const sim = createSim(score, assign(score, SLOTS), { modes: { kb: 'onset' } });
  sim.addBot(mashBot('kb', { fromMs: 1200, toMs: 9000, periodMs: 90 }));
  for (const [i, s] of [1, 2, 3, 4].entries()) sim.addBot(scoreBot(s, { jitterMs: 25, seed: 70 + i }));
  sim.advance(9000);
  const leadMs = { kb: 0 };
  let cur = null, since = 1000;
  for (const e of sim.ofType('leader')) { if (cur !== null) leadMs[cur] = (leadMs[cur] ?? 0) + e.simMs - since; cur = e.to; since = e.simMs; }
  if (cur !== null) leadMs[cur] = (leadMs[cur] ?? 0) + sim.now - since;
  assert.ok(leadMs.kb < 1500, `亂按的人帶頭了 ${leadMs.kb}ms`);
  const pos = score.midiTicksToSeconds(sim.sched.getPositionTicks());
  assert.ok(pos < 8 * 1.4, `合奏 8 秒走了 ${pos.toFixed(1)} 樂譜秒`);
});

test('五人合奏：每位演奏者的畫面狀態、樂譜條都有（5 條），顏色與名稱各不相同', async () => {
  const { slotColor, slotName } = await import('../src/score/palette.js');
  const score = loadSong('quintet', { accompaniment: true });
  const sim = createSim(score, assign(score, SLOTS));
  assert.equal(sim.sched.viewState().performers.length, 5);
  assert.equal(sim.sched.scoreView().lanes.length, 5);
  assert.equal(new Set(SLOTS.map(slotColor)).size, 5);
  assert.equal(new Set(SLOTS.map(slotName)).size, 5);
});

test('五人合奏：伴奏的表情是大家的（一半帶頭的人、一半其他正在彈的人）', () => {
  const score = loadSong('quintet', { accompaniment: true });
  const run = (exprs) => {
    const sim = createSim(score, assign(score, SLOTS));
    for (const [i, s] of SLOTS.entries()) {
      const b = sim.addBot(scoreBot(s, { jitterMs: 15, seed: 80 + i }));
      const fire = b.fire.bind(b);
      b.fire = (x) => { if (s !== 'kb') x.sched.setExpression(s, exprs[i]); fire(x); };
    }
    sim.advance(12000);
    const acc = sim.ofType('noteOn').filter((e) => e.kind === 'assist' && e.simMs > 4000);
    return acc.reduce((a, e) => a + e.velocity / e.note.velocity, 0) / acc.length;
  };
  // 帶頭的人（第一個按的）表情中性，其他人一起熱起來或冷下來：伴奏也跟著變
  const warm = run([0.5, 0.9, 0.9, 0.9, 0.9]), calm = run([0.5, 0.1, 0.1, 0.1, 0.1]);
  assert.ok(warm > calm * 1.05, `其他人熱 ${warm.toFixed(3)}、冷 ${calm.toFixed(3)}`);
});
