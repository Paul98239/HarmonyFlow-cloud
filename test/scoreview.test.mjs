// 樂譜視覺化的資料（scheduler.scoreView()／viewState()）：任何 MIDI、任何指派都畫得出來，每位演奏者一條。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSong, SONG_NAMES } from './helpers/songs.js';
import { createSim, scoreBot, beatBot, assign } from './helpers/sim.js';

test('每首歌、各種指派：每位演奏者一條，條裡剛好是他所有的音（依起音排序），拍子模式的位置不晚於起音', () => {
  for (const name of SONG_NAMES) {
    const score = loadSong(name, { accompaniment: true });
    for (const slots of [['kb'], [1, 'kb'], ['kb', 1, 2, 3], [null, 2]]) {
      const a = assign(score, slots);
      if (!a.length) continue;
      const sim = createSim(score, a);
      const v = sim.sched.scoreView();
      const groups = sim.sched.inspect().groups;
      assert.equal(v.lanes.length, groups.filter((g) => g.slot !== null).length, `${name} ${slots}`);
      for (const L of v.lanes) {
        const g = groups.find((x) => x.slot === L.slot);
        const total = g.segments.reduce((n, s) => n + s.items.length, 0);
        assert.equal(L.start.length, total);
        for (let i = 1; i < L.start.length; i++) assert.ok(L.start[i] >= L.start[i - 1]);
        for (let i = 0; i < L.start.length; i++) assert.ok(L.end[i] >= L.start[i] && L.seg[i] < g.segments.length);
        for (let j = 0; j < L.onsetSec.length; j++) assert.ok(L.pressSec[j] <= L.onsetSec[j] + 1e-9);
        assert.ok(L.lo <= L.hi);
      }
      assert.ok(v.beatSec.length > 0);
      assert.equal(sim.sched.scoreView(), v, '沒有改指派時要用快取');
    }
  }
});

test('畫面狀態：下一下（next.from）就是排程器下一個要放的起音；改指派後重算', () => {
  const score = loadSong('quartet', { accompaniment: true });
  const sim = createSim(score, assign(score, ['kb', 1]), { modes: { 1: 'beat' } });
  sim.addBot(scoreBot('kb', { jitterMs: 10 }));
  sim.addBot(beatBot(1, { jitterMs: 10 }));
  for (let t = 1500; t < 8000; t += 700) {
    sim.advance(t);
    const view = sim.sched.viewState();
    for (const p of view.performers) assert.equal(p.next.from, sim.sched.inspect().groups.find((g) => g.slot === p.slot).groupEnd);
    assert.ok(view.positionSec > 0);
  }
  const before = sim.sched.scoreView();
  sim.sched.reassign(assign(score, [1, 'kb', 2]));
  const after = sim.sched.scoreView();
  assert.notEqual(after, before);
  assert.equal(after.lanes.length, 3);
  assert.ok(after.version > before.version);
});
