// baseline.js — 單人、起音模式的手感基準：同一組樂譜與機器人，記下合成器呼叫的時刻與音高（不含力度）。
// 用法見 test/tools/gen-baseline.mjs 與 test/baseline.test.mjs。機器人刻意不用排程器之後才加的 API（只讀 inspect().groups 的 groupEnd），新舊程式跑同一份。

import { loadSong, rng } from './songs.js';

// 基準是用原本的程式在這 12 首上錄的；之後新增的測資不放進來（不然 fixture 要重錄，就不再是「原本的程式」的手感）
const BASELINE_SONGS = ['duet', 'fastRuns', 'pickup', 'irregular', 'unquantized', 'smpte', 'canonRests', 'quartet', 'pianoChords', 'drums', 'slowLong', 'solo'];

const TICK = 12;

function runOne(Scheduler, score, unitId, slot, source, { factor, jitterMs, seed, extraEvery }) {
  let now = 1000, inTrigger = false;
  const calls = [];
  const synth = (kind) => new Proxy({}, {
    get: (_, type) => (...args) => {
      const opts = ['noteOn', 'controllerChange', 'polyPressure'].includes(type) ? args[3] : type === 'noteOff' || type === 'programChange' || type === 'pitchWheel' || type === 'channelPressure' ? args[2] : type === 'systemExclusive' ? args[2] : undefined;
      // 力度（noteOn 的第三個參數）不記：階段 2 依按鍵位置與揮手刻意改變它，時刻與音高才是「手感」
      const a = type === 'noteOn' ? [args[0], args[1]] : type === 'systemExclusive' ? [] : args.slice(0, type === 'controllerChange' || type === 'polyPressure' ? 3 : 2);
      calls.push([kind, type, ...a, Math.round(now * 100) / 100, opts?.time === undefined ? null : Math.round(opts.time * 1e5) / 1e5, inTrigger ? 1 : 0]);
    },
  });
  const s = new Scheduler();
  s.setSynths(synth('A'), synth('H'));
  s.load(score, [[unitId, slot]]);
  s.play();
  const r = rng(seed);
  const segs = s.inspect().groups.find((g) => g.slot === slot)?.segments ?? [];
  const sec = (i) => score.midiTicksToSeconds(segs[i].ticks);
  let last = null, n = 0, lastKey = null, safety = 0;
  const end = 1000 + 400000;
  const keys = ['KeyF', 'KeyJ', 'KeyD'];
  while (now < end && !s.isFinished() && safety++ < 200000) {
    const g = s.inspect().groups.find((x) => x.slot === slot);
    const idx = g.groupEnd;
    let at = Infinity;
    if (idx < segs.length) at = last === null ? 1000 + (sec(idx) * 1000) / factor : last.ms + ((sec(idx) - last.sec) * 1000) / factor + (r() * 2 - 1) * jitterMs;
    if (last && last.idx === idx) at = last.ms + 300;   // 沒往前（預按、去抖）就隔 300ms 再按
    const next = now + TICK;
    if (at <= next) {
      now = Math.max(now, at);
      if (source === 'keyboard' && lastKey) s.lift({ slot, key: lastKey, source, eventTimeMs: now, receivedMs: now });
      const key = source === 'keyboard' ? keys[n % 3] : undefined;
      inTrigger = true;
      s.trigger({ slot, source, key, eventTimeMs: now - (source === 'gesture' ? 110 : 2), receivedMs: now });
      inTrigger = false;
      lastKey = key;
      const after = s.inspect().groups.find((x) => x.slot === slot);
      last = { ms: now, sec: after.lastHead !== null ? sec(after.lastHead) : sec(idx), idx };
      n++;
      if (extraEvery && n % extraEvery === 0) {   // 偶爾多按一下（連按）
        now += 35;
        inTrigger = true;
        s.trigger({ slot, source, key: source === 'keyboard' ? 'KeyL' : undefined, eventTimeMs: now - 2, receivedMs: now });
        inTrigger = false;
        if (source === 'keyboard') s.lift({ slot, key: 'KeyL', source, eventTimeMs: now + 20, receivedMs: now + 20 });
      }
      continue;
    }
    if (idx >= segs.length && lastKey && now - (last?.ms ?? 0) > 800) { s.lift({ slot, key: lastKey, source, eventTimeMs: now, receivedMs: now }); lastKey = null; }
    now = next;
    s.tick(now, now / 1000);
  }
  return { finished: s.isFinished(), calls };
}

/** 全部基準：{ 名稱 → { finished, calls } } */
export function baselineRuns(Scheduler) {
  const out = {};
  for (const name of BASELINE_SONGS) {
    const score = loadSong(name);
    score.parts.slice(0, 2).forEach((part, pi) => {
      for (const [slot, source] of [['kb', 'keyboard'], [1, 'gesture']]) {
        for (const [vi, opts] of [{ factor: 1, jitterMs: 15, seed: 1 }, { factor: 0.7, jitterMs: 40, seed: 2, extraEvery: 7 }, { factor: 1.35, jitterMs: 25, seed: 3 }].entries()) {
          out[`${name}/${part.id}/${slot}/${vi}`] = runOne(Scheduler, score, part.id, slot, source, opts);
        }
      }
      void pi;
    });
  }
  return out;
}
