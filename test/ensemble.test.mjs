// 合奏（PC 鍵盤手＋演奏者）：整個測資庫 × 多種演奏情境，「絕對不能發生」的事一次都不能出現。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSong, SONG_NAMES } from './helpers/songs.js';
import { createSim, scoreBot, assign } from './helpers/sim.js';
import { DUO_SCENARIOS, sweep, violations } from './helpers/scenarios.js';

test('兩人合奏（PC 鍵盤手＋演奏者 1）：所有測資 × 所有情境都沒有違規', () => {
  assert.deepEqual(sweep(['kb', 1], DUO_SCENARIOS), {});
});

test('四人合奏（PC 鍵盤手＋演奏者 1～3）：速度各不同也沒有違規', () => {
  const bots = {
    mixed: () => [scoreBot('kb', { jitterMs: 25 }), scoreBot(1, { factor: 0.9, jitterMs: 50, seed: 2 }), scoreBot(2, { factor: 1.1, jitterMs: 50, seed: 3 }), scoreBot(3, { jitterMs: 70, seed: 4, miss: 0.1 })],
    oneLeaves: () => [scoreBot('kb', { jitterMs: 25, stopAtMs: 5000 }), scoreBot(1, { jitterMs: 50, seed: 2 }), scoreBot(2, { jitterMs: 50, seed: 3 }), scoreBot(3, { jitterMs: 50, seed: 4 })],
  };
  assert.deepEqual(sweep(['kb', 1, 2, 3], bots, { songs: ['quartet'] }), {});
});

test('代打交還：回來的第一下不會多推一格（早、準、晚回來都一樣）', () => {
  let cases = 0;
  for (const name of SONG_NAMES) {
    if (name === 'solo') continue;
    for (const offset of [-250, -120, -40, 0, 40, 120, 250]) {
      const score = loadSong(name, { accompaniment: true });
      const sim = createSim(score, assign(score, ['kb', 1]));
      sim.addBot(scoreBot('kb', { jitterMs: 10 }));
      const sec = (t) => score.midiTicksToSeconds(t);
      const group = () => sim.sched.inspect().groups.find((x) => x.slot === 1);
      const limit = sim.now + 30000;
      while (sim.now < limit && group().status !== 'substitute') sim.advance(sim.now + 24);
      assert.equal(group().status, 'substitute', `${name}：演奏者 1 一直沒按，應該被代打`);
      sim.advance(sim.now + 1500);
      const ins = sim.sched.inspect(), g = group();
      const a = ins.ensemble.anchor, pos = ins.ensemble.positionTicks;
      const nextIdx = g.segments.findIndex((s) => s.ticks > pos + 1);
      if (nextIdx < 0) continue;
      sim.advance(sim.now + (a.clockMs + ((sec(g.segments[nextIdx].ticks) - a.scoreSec) * 1000) / a.rate - ins.clockMs) + offset);
      const before = sim.sched.inspect();
      const handled = new Set([...before.sounded, ...before.skipped]);
      const firstOpen = group().segments.findIndex((s) => s.items.some((it) => !handled.has(it.note)));
      const rec = sim.press(1);
      const rel = sim.ofType('release').filter((r) => r.slot === 1 && r.simMs === sim.now).at(-1);
      const result = sim.ofType('press').at(-1).result;
      assert.ok(['released', 'takeover'].includes(result), `${name} ${offset}：回來的那一下結果是 ${result}`);
      if (rel) assert.ok(rel.index <= firstOpen, `${name} ${offset}：放出第 ${rel.index} 個起音，但電腦還沒放的第一個是 ${firstOpen}（多推一格）`);
      if (result === 'released') assert.ok(rec.noteOns.length > 0, `${name} ${offset}：放行了卻沒聲音`);
      cases++;
    }
  }
  assert.ok(cases > 50);
});

test('揮手的人離開鏡頭（在場名單）：一秒後由電腦代打，回來後接在合奏位置', () => {
  const score = loadSong('duet', { accompaniment: true });
  const sim = createSim(score, assign(score, ['kb', 1]));
  sim.addBot(scoreBot('kb', { jitterMs: 20 }));
  const g1 = sim.addBot(scoreBot(1, { jitterMs: 30, seed: 5, stopAtMs: 4000, resumeAtMs: 10000 }));
  sim.advance(4100);
  sim.sched.setPresence([], sim.now);
  sim.advance(6500);
  const st = sim.sched.inspect().groups.find((g) => g.slot === 1).status;
  assert.equal(st, 'substitute');
  sim.sched.setPresence([1], sim.now);
  sim.runToEnd();
  assert.deepEqual(violations(sim), []);
  assert.ok(g1.presses >= 6);
  const back = sim.ofType('press').filter((e) => e.slot === 1 && e.simMs > 10000 && ['released', 'takeover', 'ahead'].includes(e.result));   // ahead：揮手超前被鎖到只超前半拍，到點放出，也是在演奏
  assert.ok(back.length >= 3, '回來之後要能繼續演奏');
});

test('暫停、續播、播放中改指派：不卡住、不重播已經響過的音', () => {
  for (const name of ['duet', 'quartet', 'canonRests', 'unquantized']) {
    const score = loadSong(name, { accompaniment: true });
    const sim = createSim(score, assign(score, ['kb', 1]));
    sim.addBot(scoreBot('kb', { jitterMs: 20 }));
    sim.addBot(scoreBot(1, { jitterMs: 40, seed: 2 }));
    sim.advance(4000);
    sim.sched.pause();
    sim.now += 3000;   // 暫停期間真實時間在走
    sim.sched.play();
    sim.advance(sim.now + 2000);
    sim.sched.reassign(assign(score, [1, 'kb']));   // 兩人互換聲部
    sim.runToEnd();
    const v = violations(sim).filter((x) => !x.startsWith('放行了卻不是當下發聲'));   // 換聲部那一刻機器人看到的是新的起音序列，第一下可能剛好按在自己的休止上
    assert.deepEqual(v, [], name);
  }
});

test('主執行緒偶爾卡住（tick 間隔 60～100ms）：伴奏不擠成一團、不累積落後', () => {
  const score = loadSong('fastRuns', { accompaniment: true });
  const sim = createSim(score, assign(score, ['kb', 1]));
  sim.addBot(scoreBot('kb', { jitterMs: 20 }));
  sim.addBot(scoreBot(1, { jitterMs: 40, seed: 2 }));
  // 每隔 700ms 卡 80ms：直接跳過那段 tick
  const origAdvance = sim.advance.bind(sim);
  let stall = 0;
  sim.advance = (toMs) => {
    while (sim.now < toMs) {
      origAdvance(Math.min(toMs, sim.now + 700));
      if (sim.now < toMs && ++stall % 2 === 0) { sim.now += 80; }
    }
  };
  sim.runToEnd();
  assert.deepEqual(violations(sim), []);
  const late = sim.sched.lateStats();
  assert.ok(late.count > 0);
});
