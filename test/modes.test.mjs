// 演奏模式（音樂家／起音／拍子）與智能切換。規則掃整個測資庫。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSong, SONG_NAMES } from './helpers/songs.js';
import { createSim, scoreBot, beatBot, onsetBot, mashBot, assign } from './helpers/sim.js';
import { DUO_SCENARIOS, sweep, violations } from './helpers/scenarios.js';
import { beatLines, BEAT_MAX_SEC } from '../src/midi/beats.js';
import { SUBSTITUTE_VELOCITY } from '../src/midi/scheduler.js';

const partSlots = (score, part, slot = 1) => { const s = []; s[part] = slot; return assign(score, s); };
const mineOf = (sim, slot) => sim.sched.inspect().groups.find((g) => g.slot === slot).segments.flatMap((s) => s.items.map((it) => it.note));

test('拍線：任何檔案都有，相鄰拍線不超過 BEAT_MAX_SEC（一下不會自動放太久）', () => {
  for (const name of SONG_NAMES) {
    const score = loadSong(name);
    const { lines } = beatLines(score);
    assert.ok(lines.length >= 4, `${name}：拍線太少`);
    for (let i = 1; i < lines.length; i++) {
      const d = score.midiTicksToSeconds(lines[i]) - score.midiTicksToSeconds(lines[i - 1]);
      assert.ok(d > 0 && d <= BEAT_MAX_SEC + 1e-6, `${name}：第 ${i} 拍長 ${d.toFixed(2)} 秒`);
    }
  }
});

test('拍線：沒有拍格線（SMPTE）或拍子對不上音（未量化錄製）時從起音估脈動', () => {
  for (const name of ['smpte', 'unquantized']) assert.equal(beatLines(loadSong(name)).source, 'pulse', name);
  for (const name of ['duet', 'pickup', 'irregular', 'fastRuns']) assert.equal(beatLines(loadSong(name)).source, 'grid', name);
  // 未量化：產生器的真實拍長約 0.79 秒（76 BPM，±15% 隨機）
  const score = loadSong('unquantized');
  const { lines } = beatLines(score);
  const d = lines.slice(1).map((t, i) => score.midiTicksToSeconds(t) - score.midiTicksToSeconds(lines[i])).sort((a, b) => a - b);
  const median = d[d.length >> 1];
  assert.ok(median > 0.68 && median < 0.9, `估到的拍長 ${median.toFixed(3)}`);
});

test('拍子模式：只跟著拍子揮，每首歌每個聲部都完整奏完（含快音群、顫音），沒有違規', () => {
  for (const name of SONG_NAMES) {
    for (const part of [0, 1]) {
      for (const [source, factor] of [['gesture', 1], ['keyboard', 0.8], ['gesture', 1.2]]) {
        const score = loadSong(name, { accompaniment: true });
        if (!score.parts[part]) continue;
        const slot = source === 'keyboard' ? 'kb' : 1;
        const sim = createSim(score, partSlots(score, part, slot), { modes: { [slot]: 'beat' } });
        sim.addBot(beatBot(slot, { jitterMs: 40, factor, source }));
        sim.runToEnd(300000);
        const ins = sim.sched.inspect(), mine = mineOf(sim, slot);
        const missing = mine.filter((n) => !ins.sounded.has(n));
        assert.deepEqual(missing.length, 0, `${name} 聲部 ${part} ${source} ×${factor}：${missing.length}/${mine.length} 個音沒響`);
        assert.deepEqual(violations(sim), [], `${name} 聲部 ${part} ${source} ×${factor}`);
      }
    }
  }
});

test('拍子模式：一下自動放的音不超過一拍（快歌合併時不超過 1.6 秒）', () => {
  for (const name of SONG_NAMES) {
    const score = loadSong(name);
    const sim = createSim(score, partSlots(score, 0), { modes: { 1: 'beat' } });
    sim.addBot(beatBot(1, { jitterMs: 20 }));
    sim.runToEnd(300000);
    const autos = sim.ofType('autoRelease'), rel = sim.ofType('release');
    for (const r of rel) {
      const last = autos.filter((a) => a.simMs >= r.simMs && rel.every((x) => x === r || x.simMs <= r.simMs || x.simMs > a.simMs)).at(-1);
      if (last) assert.ok(last.dueMs - r.clockMs <= 1600 + 1, `${name}：一下放了 ${(last.dueMs - r.clockMs).toFixed(0)}ms`);
    }
  }
});

test('拍子模式：快速亂按不會讓歌越跑越快（速度不超過 1.6 倍）', () => {
  for (const source of ['keyboard', 'gesture']) {
    const score = loadSong('duet', { accompaniment: true });
    const slot = source === 'keyboard' ? 'kb' : 1;
    const sim = createSim(score, partSlots(score, 0, slot), { modes: { [slot]: 'beat' } });
    sim.addBot(mashBot(slot, { fromMs: 1000, toMs: 9000, periodMs: 80, source }));
    sim.advance(9000);
    const pos = sim.score.midiTicksToSeconds(sim.sched.getPositionTicks());
    assert.ok(pos <= 8 * 1.6 + 0.7, `${source}：亂按 8 秒走了 ${pos.toFixed(2)} 樂譜秒`);
    assert.ok(sim.sched.playbackRate <= 1.6 + 1e-9);
  }
});

test('同一首歌裡不同人用不同模式：合奏規則照樣成立', () => {
  const mixes = [{ kb: 'musician', 1: 'beat' }, { kb: 'beat', 1: 'onset' }, { kb: 'onset', 1: 'musician' }, { kb: 'beat', 1: 'beat' }];
  for (const modes of mixes) assert.deepEqual(sweep(['kb', 1], DUO_SCENARIOS, { modes }), {}, JSON.stringify(modes));
  const quartet = { mixed: () => [scoreBot('kb', { jitterMs: 25 }), beatBot(1, { jitterMs: 50 }), scoreBot(2, { factor: 1.05, jitterMs: 50, seed: 3 }), scoreBot(3, { jitterMs: 60, seed: 4 })] };
  assert.deepEqual(sweep(['kb', 1, 2, 3], quartet, { songs: ['quartet'], modes: { kb: 'onset', 1: 'beat', 2: 'musician', 3: 'auto' } }), {});
});

test('音樂家模式：他按的每一下都算（80ms 的連按也放行），起音模式會擋', () => {
  const run = (mode) => {
    const score = loadSong('fastRuns');
    const sim = createSim(score, partSlots(score, 0, 'kb'), { modes: { kb: mode } });
    sim.advance(1000); sim.press('kb'); sim.advance(1000 + 4 * 625);   // 第 5 個起音附近（十六分音符段之前是四分音符）
    sim.press('kb', { key: 'KeyJ' });
    sim.advance(sim.now + 80);
    return sim.press('kb', { key: 'KeyK' }).released;
  };
  assert.equal(run('musician'), true);
  assert.equal(run('onset'), false);
});

test('畫面預告的「下一下會放出哪些音」：拍子模式跟實際一樣；起音模式至少 95%', () => {
  for (const [mode, need] of [['beat', 1], ['onset', 0.95]]) {
    let ok = 0, total = 0;
    for (const name of SONG_NAMES) {
      const score = loadSong(name);
      const sim = createSim(score, partSlots(score, 0), { modes: { 1: mode } });
      const bot = sim.addBot(scoreBot(1, { jitterMs: 30, seed: 7 }));
      const fire = bot.fire.bind(bot);
      bot.fire = (s) => {
        const v = s.sched.viewState().performers.find((p) => p.slot === 1);
        const n = s.ofType('release').length;
        fire(s);
        const rel = s.ofType('release').slice(n).find((r) => r.slot === 1);
        if (!rel || s.ofType('press').at(-1).jumped) return;
        const g = s.sched.inspect().groups.find((x) => x.slot === 1);
        total++;
        if (rel.index === v.next.from && g.groupEnd === v.next.to) ok++;
      };
      sim.runToEnd(300000);
    }
    assert.ok(total > 100 && ok / total >= need, `${mode}：${ok}/${total}`);
  }
});

test('智能切換（自動）：照穩定拍子按的人 → 拍子；亂按 → 拍子；在拍子模式照每個音按 → 起音；固定模式只給建議', () => {
  const modeAfter = (name, part, setting, mkBot, untilMs = 20000) => {
    const score = loadSong(name, { accompaniment: true });
    const sim = createSim(score, partSlots(score, part), { modes: { 1: setting } });
    sim.addBot(mkBot());
    sim.advance(untilMs);
    return { v: sim.sched.viewState().performers.find((p) => p.slot === 1), events: sim.ofType('mode') };
  };
  // 照拍子按（起音模式下，每一下的樂譜間隔不平均）
  let r = modeAfter('duet', 0, 'auto', () => beatBot(1, { jitterMs: 20 }));
  assert.equal(r.v.mode, 'beat');
  assert.equal(r.events.at(-1).reason, 'pulse');
  // 固定起音：不切，只建議
  r = modeAfter('duet', 0, 'onset', () => beatBot(1, { jitterMs: 20 }));
  assert.equal(r.v.mode, 'onset');
  assert.equal(r.v.suggestion?.mode, 'beat');
  // 亂按
  r = modeAfter('duet', 0, 'auto', () => mashBot(1, { fromMs: 1000, toMs: 8000, periodMs: 90 }), 8000);
  assert.equal(r.v.mode, 'beat');
  // 拍子模式（自動會從起音開始，所以先讓它到拍子）照每個音按 → 起音
  const score = loadSong('duet', { accompaniment: true });
  const sim = createSim(score, partSlots(score, 0), { modes: { 1: 'beat' } });
  sim.sched.setMode(1, 'auto');
  sim.addBot(onsetBot(1, { jitterMs: 15 }));
  sim.advance(18000);
  assert.equal(sim.sched.viewState().performers.find((p) => p.slot === 1).mode, 'onset');
  // 很穩的人：只建議音樂家，自動也不升上去
  r = modeAfter('duet', 1, 'auto', () => scoreBot(1, { jitterMs: 10 }), 22000);
  assert.notEqual(r.v.mode, 'musician');
});

test('跟不上：先顯示「落後」，仍跟不上（落後好幾拍）才由電腦代打，代打的音比原檔小聲', () => {
  const score = loadSong('duet', { accompaniment: true });
  const sim = createSim(score, assign(score, ['kb', 1]));
  sim.addBot(scoreBot('kb', { jitterMs: 15 }));
  sim.addBot(scoreBot(1, { jitterMs: 20, seed: 4, stopAtMs: 4500 }));
  const states = [];
  for (let t = 4500; t < 12000; t += 100) { sim.advance(t); states.push(sim.sched.viewState().performers.find((p) => p.slot === 1).state); }
  const firstBehind = states.indexOf('behind'), firstSub = states.indexOf('substitute');
  assert.ok(firstBehind >= 0 && firstSub > firstBehind, `落後 ${firstBehind}、代打 ${firstSub}`);
  const subOns = sim.ofType('noteOn').filter((e) => e.kind === 'human' && e.simMs > 4500 + firstSub * 100 && e.staffId.startsWith('t2'));
  assert.ok(subOns.length > 0);
  for (const e of subOns) assert.ok(e.velocity <= Math.round(e.note.velocity * SUBSTITUTE_VELOCITY) + 1, `代打的力度 ${e.velocity}（原檔 ${e.note.velocity}）`);
});

test('拍子模式「開始這一拍」：他這拍的音在拍線之後時，按下去合奏的拍上音當下響，他的音照樂譜在拍內出來', () => {
  const score = loadSong('quartet', { accompaniment: true });   // 第 4 聲部（貝斯）從後半拍進
  const sim = createSim(score, partSlots(score, 3), { modes: { 1: 'beat' } });
  sim.addBot(beatBot(1, { jitterMs: 10 }));
  sim.runToEnd();
  const beats = sim.triggers.filter((t) => sim.ofType('press').find((p) => p.simMs === t.atMs && p.result === 'beat'));
  assert.ok(beats.length > 5);
  // 拍上的伴奏音可能已經照 lookahead 帶時間戳提早送出（取消不了，會在拍線的時刻響）：算按下前後 50ms 內真的發聲的伴奏音
  const soundAt = (c) => (c.time !== undefined ? Math.max(c.time * 1000, c.at) : c.at);
  const assistOns = sim.noteOns('assist');
  // 揮手的「那一刻」是手到最低點（動作時刻，比程式收到早約 110ms）：從動作時刻到收到之後 50ms 之內要有拍上的音
  for (const t of beats) assert.ok(assistOns.some((c) => soundAt(c) >= t.atMs - 160 && soundAt(c) <= t.atMs + 50), `按下去的那一刻沒有任何聲音（${t.atMs}）`);
  assert.deepEqual(violations(sim), []);
});

test('音的長短：起音與音樂家模式由放開決定（keyup），拍子模式照樂譜', () => {
  const lenOf = (mode) => {
    const score = loadSong('slowLong');   // 第一個音是 4 拍（約 4 秒）的長音
    const sim = createSim(score, partSlots(score, 0, 'kb'), { modes: { kb: mode } });
    sim.advance(1000);
    sim.press('kb', { key: 'KeyF' });
    sim.advance(1300);
    sim.lift('kb', 'KeyF');
    sim.advance(2000);
    const on = sim.human.calls.find((c) => c.type === 'noteOn'), off = sim.human.calls.find((c) => c.type === 'noteOff' && c.a === on.a);
    return off ? off.at - on.at : Infinity;
  };
  assert.ok(lenOf('onset') < 400);
  assert.ok(lenOf('musician') < 400);
  assert.ok(lenOf('beat') > 900);
});

test('智能切換：還沒按過任何一下的人（一直不在、被代打）不會被切換模式', () => {
  const score = loadSong('duet', { accompaniment: true });
  const sim = createSim(score, assign(score, ['kb', 1]), { modes: { kb: 'auto', 1: 'auto' } });
  sim.addBot(scoreBot(1, { jitterMs: 20 }));
  sim.advance(15000);
  const kb = sim.sched.viewState().performers.find((p) => p.slot === 'kb');
  assert.equal(kb.state, 'substitute');
  assert.equal(kb.mode, 'onset');
  assert.equal(kb.suggestion, null);
});
