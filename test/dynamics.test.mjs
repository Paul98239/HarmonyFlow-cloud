// 力度、音量與情緒：按鍵位置、揮手的幅度與速度、落拍／代打變小聲、外接框的表情。
import test from 'node:test';
import assert from 'node:assert/strict';
import { keyIntensity, performerVelocity, SmoothGain } from '../src/midi/dynamics.js';
import { ArcDetector } from '../src/vision/gesture.js';
import { ExpressionTracker } from '../src/vision/expression.js';
import { loadSong } from './helpers/songs.js';
import { createSim, scoreBot, beatBot, assign } from './helpers/sim.js';
import { body, trackOf, waveAt, ASPECT } from './helpers/pose.js';

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const partSlots = (score, part, slot = 1) => { const s = []; s[part] = slot; return assign(score, s); };

test('鍵盤：按鍵左到右的位置 → 力道 0～1，空白鍵中性；每排都由左往右遞增', () => {
  assert.equal(keyIntensity('Space'), 0.5);
  for (const row of ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']) {
    const codes = row.split('').map((c) => (/\d/.test(c) ? `Digit${c}` : `Key${c}`));
    for (let i = 1; i < codes.length; i++) assert.ok(keyIntensity(codes[i]) > keyIntensity(codes[i - 1]), codes[i]);
  }
  assert.ok(keyIntensity('Backquote') < 0.05 && keyIntensity('Backslash') > 0.95);
});

test('鍵盤：左邊的鍵小聲、右邊的鍵大聲；音樂家模式的範圍更大', () => {
  const vel = (mode, key) => {
    const score = loadSong('duet');
    const sim = createSim(score, partSlots(score, 0, 'kb'), { modes: { kb: mode } });
    sim.advance(1000);
    const out = [];
    for (let i = 0; i < 8; i++) { const r = sim.press('kb', { key, intensity: keyIntensity(key) }); out.push(...r.noteOns.map((c) => c.b)); sim.advance(sim.now + 600); sim.lift('kb', key); }
    return mean(out);
  };
  for (const mode of ['onset', 'beat', 'musician']) {
    const soft = vel(mode, 'KeyA'), loud = vel(mode, 'Semicolon');
    assert.ok(loud > soft * 1.3, `${mode}：左 ${soft.toFixed(0)}、右 ${loud.toFixed(0)}`);
  }
  assert.ok(vel('musician', 'Semicolon') - vel('musician', 'KeyA') > vel('onset', 'Semicolon') - vel('onset', 'KeyA'));
});

test('力度換算：中性時（力道、表情 0.5、倍率 1）起音／拍子模式就是原檔力度', () => {
  for (const v of [1, 40, 80, 127]) for (const mode of ['onset', 'beat']) assert.equal(performerVelocity(v, { mode }), v);
});

test('平滑倍率：目標改變時漸變過去，不會一下子跳', () => {
  const g = new SmoothGain(1);
  g.at(1, 0);
  const vals = [];
  for (let t = 0; t <= 4000; t += 100) vals.push(g.at(0.6, t));
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i - 1] - vals[i] < 0.06);
  assert.ok(vals.at(-1) < 0.62);
});

test('落拍的人變小聲、被代打時更小聲，都是漸變；帶頭的人不會因為「落拍」變小聲', () => {
  const score = loadSong('duet', { accompaniment: true });
  const sim = createSim(score, assign(score, ['kb', 1]));
  sim.addBot(scoreBot('kb', { jitterMs: 10 }));
  sim.addBot(scoreBot(1, { jitterMs: 15, seed: 3, factor: 1, stopAtMs: 6000 }));
  sim.runToEnd();
  const mine = sim.ofType('noteOn').filter((e) => e.kind === 'human' && e.staffId === sim.sched.inspect().staves.find((s) => s.slot === 1).id);
  const ratio = mine.map((e) => e.velocity / e.note.velocity);
  const before = ratio.filter((_, i) => mine[i].simMs < 6000), after = ratio.filter((_, i) => mine[i].simMs > 10000);
  assert.ok(mean(before) > 0.95, `正常演奏時 ${mean(before).toFixed(2)}`);
  assert.ok(after.length && Math.max(...after) <= 0.62, `代打後期 ${Math.max(...after).toFixed(2)}`);
  // 漸變：相隔不到 1.5 秒的兩顆音，力度倍率不會差超過 0.2
  for (let i = 1; i < ratio.length; i++) {
    if (mine[i].simMs - mine[i - 1].simMs <= 1500) assert.ok(ratio[i - 1] - ratio[i] < 0.2, `第 ${i} 顆音力度一下子掉 ${(ratio[i - 1] - ratio[i]).toFixed(2)}`);
  }
  const leaderRatio = sim.ofType('noteOn').filter((e) => e.kind === 'human' && e.staffId !== mine[0].staffId).map((e) => e.velocity / e.note.velocity);
  assert.ok(Math.min(...leaderRatio) > 0.95, '帶頭的人（PC 鍵盤手）不該變小聲');
});

// ─── 揮手的力道 ───
function waveFrames(det, { amp, periodMs, scale = 0.15, cx = 0.5, cy = 0.35, ms = 12000, fps = 30 }) {
  const out = [];
  let lastSeq = 0;
  for (let t = 0; t < ms; t += 1000 / fps) {
    const w = waveAt(t, { amp, periodMs });
    const r = det.update({ point: { x: cx + w.x * scale, y: cy + (w.y * scale) / ASPECT, presence: 0.95 }, scale, aspect: ASPECT }, t, t);
    if (r.triggerSeq > lastSeq) { out.push(r.intensity); lastSeq = r.triggerSeq; }
  }
  return out;
}

test('揮手的力道：大而快 > 小而慢；站遠站近一樣', () => {
  const big = waveFrames(new ArcDetector(), { amp: 1.6, periodMs: 900 });
  const small = waveFrames(new ArcDetector(), { amp: 0.35, periodMs: 1600 });
  assert.ok(big.length > 5 && small.length > 3);
  assert.ok(mean(big) > mean(small) + 0.15, `大 ${mean(big).toFixed(2)}、小 ${mean(small).toFixed(2)}`);
  const near = waveFrames(new ArcDetector(), { amp: 1, periodMs: 1100, scale: 0.28 });
  const far = waveFrames(new ArcDetector(), { amp: 1, periodMs: 1100, scale: 0.09 });
  assert.ok(Math.abs(mean(near) - mean(far)) < 0.04, `近 ${mean(near).toFixed(3)}、遠 ${mean(far).toFixed(3)}`);
});

test('揮手的力道：動作天生小的人不會永遠小聲——比他平常大就變大聲', () => {
  const det = new ArcDetector();
  const habitual = waveFrames(det, { amp: 0.4, periodMs: 1300 });
  const bigger = waveFrames(det, { amp: 0.8, periodMs: 1000, ms: 4000 });
  assert.ok(mean(habitual.slice(3)) > 0.3, `他平常的揮法 ${mean(habitual.slice(3)).toFixed(2)}`);
  assert.ok(mean(bigger) > mean(habitual.slice(3)) + 0.15, `比平常大 ${mean(bigger).toFixed(2)}`);
});

// ─── 外接框的表情 ───
function runExpression(tr, { amp, periodMs, scale = 0.15, seated = false, cx = 0.5, ms = 15000, both = true }) {
  const vals = [];
  for (let t = 0; t < ms; t += 33) {
    const w = waveAt(t, { amp, periodMs });
    const lw = both ? { x: -w.x, y: w.y } : { x: -0.6, y: 1.5 };
    const r = tr.update(trackOf(body({ cx, scale, rw: w, lw, seated }), scale), t);
    if (t > ms - 5000) vals.push(r.energy);
  }
  return mean(vals);
}

test('表情：同一個人在同一首歌裡大而快的動作比小而慢的 energy 高', () => {
  const tr = new ExpressionTracker('wave');
  const calm = runExpression(tr, { amp: 0.3, periodMs: 2200 });
  const lively = runExpression(tr, { amp: 1.8, periodMs: 800, ms: 6000 });
  assert.ok(lively > calm + 0.2, `小而慢 ${calm.toFixed(2)}、大而快 ${lively.toFixed(2)}`);
});

test('表情：走近走遠不算動作變大變小；坐著（下半身不在畫面）也算得出來', () => {
  const near = runExpression(new ExpressionTracker(), { amp: 1, periodMs: 1100, scale: 0.3 });
  const far = runExpression(new ExpressionTracker(), { amp: 1, periodMs: 1100, scale: 0.08 });
  assert.ok(Math.abs(near - far) < 0.03, `近 ${near.toFixed(3)}、遠 ${far.toFixed(3)}`);
  const seated = runExpression(new ExpressionTracker(), { amp: 1, periodMs: 1100, seated: true });
  assert.ok(Math.abs(seated - near) < 0.03, `坐著 ${seated.toFixed(3)}`);
  // 一邊走近一邊揮：energy 跟站著不動揮一樣
  const tr = new ExpressionTracker(), vals = [];
  for (let t = 0; t < 15000; t += 33) {
    const scale = 0.08 + (0.22 * t) / 15000, w = waveAt(t, { amp: 1, periodMs: 1100 });
    const r = tr.update(trackOf(body({ scale, rw: w, lw: { x: -w.x, y: w.y } }), scale), t);
    if (t > 10000) vals.push(r.energy);
  }
  assert.ok(Math.abs(mean(vals) - near) < 0.05, `走近中 ${mean(vals).toFixed(3)}`);
});

test('表情：動作天生小的人，比他自己平常大就有活力（不會永遠被當成沒情緒）', () => {
  const tr = new ExpressionTracker();
  const usual = runExpression(tr, { amp: 0.35, periodMs: 1500, both: false });
  const more = runExpression(tr, { amp: 0.8, periodMs: 1100, both: false, ms: 5000 });
  assert.ok(more > usual + 0.12, `平常 ${usual.toFixed(2)}、比平常大 ${more.toFixed(2)}`);
});

test('同一首歌：大而快與小而慢的動作，聽得出不同的表情（力度、伴奏、速度都不同）', () => {
  const run = ({ intensity, expression, factor }) => {
    const score = loadSong('duet', { accompaniment: true });
    const sim = createSim(score, partSlots(score, 0), { modes: { 1: 'beat' } });
    const bot = sim.addBot(beatBot(1, { factor, jitterMs: 20 }));
    const fire = bot.fire.bind(bot);
    sim.press = ((orig) => (slot, opts = {}) => orig(slot, { ...opts, intensity }))(sim.press.bind(sim));
    bot.fire = (s) => { s.sched.setExpression(1, expression); fire(s); };
    sim.runToEnd();
    const ons = sim.ofType('noteOn');
    return {
      own: mean(ons.filter((e) => e.kind === 'human').map((e) => e.velocity / e.note.velocity)),
      acc: mean(ons.filter((e) => e.kind === 'assist').map((e) => e.velocity / e.note.velocity)),
      sec: (sim.now - 1000) / 1000,
    };
  };
  const lively = run({ intensity: 0.8, expression: 0.8, factor: 1.2 }), calm = run({ intensity: 0.25, expression: 0.25, factor: 0.85 });
  assert.ok(lively.own > calm.own * 1.35, `他的音 ${lively.own.toFixed(2)} vs ${calm.own.toFixed(2)}`);
  assert.ok(lively.acc > calm.acc * 1.1, `伴奏 ${lively.acc.toFixed(2)} vs ${calm.acc.toFixed(2)}`);
  assert.ok(lively.sec < calm.sec * 0.8, `長度 ${lively.sec.toFixed(1)} vs ${calm.sec.toFixed(1)} 秒`);
});
