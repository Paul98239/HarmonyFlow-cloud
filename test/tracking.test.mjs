// 多人追蹤：靠近、交錯、被擋、輸出順序打亂、幽靈骨架時 ID 不跳；追丟回來拿回原本的 ID；別人的手不會接到自己身上；鎖定新 ID 要看得到臉。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCrowd, idSwitches } from './helpers/crowd.js';
import { body, ASPECT } from './helpers/pose.js';
import { buildDetection, PersonTracker } from '../src/vision/tracking.js';
import { loadSong } from './helpers/songs.js';
import { createSim, scoreBot, assign } from './helpers/sim.js';

const lerp = (a, b, k) => a + (b - a) * k;
const tri = (t, ms) => { const k = (t % ms) / ms; return k < 0.5 ? k * 2 : 2 - k * 2; };
const SCENES = {
  靠近再分開: [{ path: (t) => ({ cx: lerp(0.3, 0.44, tri(t, 6000)), cy: 0.38, scale: 0.12 }) }, { path: (t) => ({ cx: lerp(0.7, 0.56, tri(t, 6000)), cy: 0.38, scale: 0.12 }) }],
  肩並肩: [{ path: (t) => ({ cx: lerp(0.3, 0.455, tri(t, 5000)), cy: 0.38, scale: 0.13 }) }, { path: (t) => ({ cx: lerp(0.7, 0.545, tri(t, 5000)), cy: 0.39, scale: 0.12 }) }],
  交錯被擋: [
    { path: (t) => ({ cx: lerp(0.2, 0.8, t / 8000), cy: 0.36, scale: 0.14 }) },
    { path: (t) => ({ cx: lerp(0.8, 0.2, t / 8000), cy: 0.33, scale: 0.09 }), visible: (t, all) => Math.abs(all[0].cx - all[1].cx) > 0.08 },
  ],
  靠過去: [{ path: (t) => ({ cx: 0.38 + (t > 3000 && t < 4000 ? 0.07 : 0), cy: 0.38, scale: 0.13 }) }, { path: () => ({ cx: 0.6, cy: 0.38, scale: 0.13 }) }],
  四人: [0.2, 0.4, 0.6, 0.8].map((x, i) => ({ path: (t) => ({ cx: x + 0.06 * Math.sin(t / 700 + i), cy: 0.37, scale: 0.1 }) })),
  四人擠在一起: [0.32, 0.44, 0.56, 0.68].map((x, i) => ({ path: (t) => ({ cx: x + 0.025 * Math.sin(t / 500 + i * 1.7), cy: 0.37 + 0.01 * i, scale: 0.09 }) })),
};

test('多人靠近、交錯、被擋、輸出順序打亂、幽靈骨架：每個人的 ID 從頭到尾不變，也不會兩個 ID 在同一個人身上', () => {
  for (const [name, people] of Object.entries(SCENES)) {
    for (const ghosts of [0, 0.3]) {
      for (const seed of [1, 2, 3]) {
        const r = runCrowd(people, { ghosts, seed, ms: 9000 });
        const s = idSwitches(r.frames);
        assert.equal(s.switches, 0, `${name} 幽靈 ${ghosts} 種子 ${seed}：ID 換了 ${s.switches} 幀`);
        assert.equal(s.dups, 0, `${name}：同一個人兩個 ID`);
        assert.ok(s.first.every((id) => id !== null), `${name}：有人沒被鎖定`);
      }
    }
  }
});

test('追丟再回來：拿回原本的 ID（兩個人一起離開、換了順序回來也不會互換）', () => {
  const people = [
    { path: () => ({ cx: 0.2, cy: 0.38, scale: 0.11 }), visible: (t) => !(t > 2000 && t < 4600) },
    { path: () => ({ cx: 0.5, cy: 0.38, scale: 0.11 }) },
    { path: () => ({ cx: 0.8, cy: 0.38, scale: 0.11 }), visible: (t) => !(t > 2000 && t < 4200) },
  ];
  const r = runCrowd(people, { ms: 7000 });
  assert.ok(r.events.filter((e) => e.type === 'loss').length >= 2, '應該真的有追丟');
  assert.equal(idSwitches(r.frames).switches, 0);
});

test('別人的手不會接到自己身上：解剖上不可能的手腕這一幀隱藏、位置不動', () => {
  const tr = new PersonTracker({ maxUsers: 2 });
  for (let t = 0; t < 1000; t += 33) {
    const a = body({ cx: 0.4, scale: 0.12 }), b = body({ cx: 0.62, scale: 0.12, rw: { x: 0.9, y: 0.2 } });
    if (t > 600) a[16] = { ...b[16] };   // MediaPipe 把 B 的右手腕接到 A 身上
    tr.update([a, b].map((lm) => buildDetection(lm, { aspect: ASPECT })), t);
  }
  const ta = tr.getActiveTracks().find((x) => Math.abs(x.centroid.x - 0.4) < 0.05);
  const tb = tr.getActiveTracks().find((x) => Math.abs(x.centroid.x - 0.62) < 0.05);
  assert.equal(ta.smoothed[16].visible, false);
  assert.ok(Math.abs(ta.smoothed[16].x - (0.4 + 0.9 * 0.12)) < 0.02, 'A 的右手腕停在他自己原本的位置');
  assert.equal(tb.smoothed[16].visible, true, 'B 自己的手照常');
});

test('正常的揮手（單人、多人、站遠站近）從來不會被當成不可信而隱藏手腕', () => {
  for (const people of [[{ path: () => ({ cx: 0.5, cy: 0.38, scale: 0.15 }) }], SCENES.四人, SCENES.肩並肩, [{ path: (t) => ({ cx: 0.5, cy: 0.3, scale: lerp(0.07, 0.3, t / 9000) }) }]]) {
    const tr = new PersonTracker({ maxUsers: people.length });
    let hidden = 0;
    for (let t = 0; t < 9000; t += 33) {
      const dets = people.map((p, i) => {
        const { cx, cy, scale } = p.path(t), ph = (t / 1100 + i * 0.3) % 1;
        return buildDetection(body({ cx, cy, scale, rw: { x: 0.6 + 0.7 * Math.sin(2 * Math.PI * ph), y: 0.4 + 1.1 * Math.sin(Math.PI * ((ph * 2) % 1)) }, lw: { x: -1.3, y: -0.4 } }), { aspect: ASPECT });
      });
      tr.update(dets, t);
      if (t > 1000) for (const track of tr.getActiveTracks()) for (const j of [15, 16]) if (!track.smoothed[j].visible) hidden++;
    }
    assert.equal(hidden, 0);
  }
});

test('鎖定新 ID 要看得到臉；已經在追蹤的人轉頭（看不到臉）照樣追', () => {
  const run = (faceAt) => {
    const tr = new PersonTracker({ maxUsers: 1 });
    let locked = null;
    for (let t = 0; t < 3000; t += 33) {
      tr.update([buildDetection(body({ cx: 0.5, scale: 0.14, faceVisible: faceAt(t) }), { aspect: ASPECT })], t);
      if (locked === null && tr.getActiveTracks().length) locked = t;
    }
    return { locked, active: tr.getActiveTracks().length };
  };
  assert.equal(run(() => false).locked, null, '從頭到尾背對鏡頭：不鎖定');
  assert.ok(run((t) => t > 1000).locked >= 1000, '轉過來看得到臉才鎖定');
  const turned = run((t) => t < 800);
  assert.ok(turned.locked !== null && turned.active === 1, '鎖定之後轉頭照樣追');
});

test('幽靈 ID：先進場的聲部指派給沒出現的人，在場的人照樣演奏到最後（那個聲部由電腦小聲代打）', () => {
  for (const ghost of [3, 'kb']) {
    const score = loadSong('canonRests', { accompaniment: true });
    const sim = createSim(score, assign(score, [ghost, 1]));
    sim.sched.setPresence([1], sim.now);
    sim.addBot(scoreBot(1, { jitterMs: 20, lagFromStart: 4800 }));
    sim.advance(40000);
    assert.ok(sim.sched.isFinished(), `幽靈 ${ghost}：沒有奏完`);
    const v = sim.sched.viewState().performers;
    assert.equal(v.find((p) => p.slot === ghost).state, 'substitute');
  }
});
