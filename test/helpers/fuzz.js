// fuzz.js — 模糊測試：隨機產生「我們沒想到的」MIDI 與演奏情況。同一個種子產生同一個案例（失敗時可以重現：node test/tools/fuzz.mjs <種子>）。
//
// 檔案：PPQ 24～960 或 SMPTE（24／25／30 fps）、速度 20～300 BPM 並在中途亂變、奇怪的拍號（7/16、13/8、1/4…）、1～6 個聲部（可能有鼓）、
//       和弦、0 長度的音、同音高重疊、很密的音群、很長的音、長達 30 秒的空白、從 tick 0 開始或很晚才開始。
// 演奏：PC 鍵盤手與演奏者 1～4 隨機取幾個指派、模式隨機、每個人的行為隨機（照音符、照拍子、亂按、中途離開、從沒來、很慢、很快、漏按多按）。

import { buildMidi } from './smf.js';
import { parseMidi } from '../../src/midi/midiParser.js';
import { createSim, scoreBot, beatBot, onsetBot, mashBot, assign } from './sim.js';
import { rng } from './songs.js';

const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

export function fuzzSpec(seed) {
  const r = rng(seed * 7919 + 13);
  const smpte = r() < 0.15 ? { fps: pick(r, [24, 25, 30]), tpf: int(r, 4, 80) } : null;
  const ppq = smpte ? smpte.fps * smpte.tpf : pick(r, [24, 48, 96, 120, 192, 384, 480, 960]);
  const beat = smpte ? Math.round(ppq * 0.5) : ppq;   // 大約一拍幾個 tick
  const totalBeats = int(r, 8, 60);
  const tempos = [{ tick: 0, bpm: int(r, 20, 300) }];
  for (let i = 0, n = int(r, 0, 4); i < n; i++) tempos.push({ tick: int(r, 1, totalBeats) * beat, bpm: int(r, 20, 300) });
  tempos.sort((a, b) => a.tick - b.tick);
  const timeSigs = smpte || r() < 0.2 ? [] : [{ tick: 0, ...pick(r, [{ num: 4, den: 4 }, { num: 3, den: 4 }, { num: 6, den: 8, cc: 36 }, { num: 7, den: 16 }, { num: 13, den: 8 }, { num: 1, den: 4 }, { num: 5, den: 4 }]) }];
  if (timeSigs.length && r() < 0.4) timeSigs.push({ tick: int(r, 1, totalBeats) * beat, ...pick(r, [{ num: 2, den: 4 }, { num: 9, den: 8 }, { num: 3, den: 2 }]) });
  timeSigs.sort((a, b) => a.tick - b.tick);
  const nParts = int(r, 1, 6);
  const parts = [];
  for (let p = 0; p < nParts; p++) {
    const notes = [];
    let t = r() < 0.3 ? int(r, 0, 8) * beat : 0;
    const style = pick(r, ['steady', 'dense', 'sparse', 'chords', 'long', 'random']);
    while (t < totalBeats * beat) {
      const step = style === 'dense' ? Math.max(1, Math.round(beat / pick(r, [4, 8, 16, 32]))) : style === 'sparse' ? beat * int(r, 2, 8) : style === 'long' ? beat * int(r, 2, 12) : style === 'random' ? int(r, 0, beat * 2) : Math.round(beat / pick(r, [1, 2, 3]));
      const dur = r() < 0.05 ? 0 : style === 'long' ? step * int(r, 1, 3) : Math.max(0, Math.round(step * (0.2 + r() * 1.3)));
      const k = style === 'chords' ? int(r, 2, 5) : 1;
      for (let c = 0; c < k; c++) notes.push({ tick: t, dur, pitch: 36 + ((p * 7 + c * 4 + notes.length) % 60), vel: int(r, 1, 127) });
      if (r() < 0.03) notes.push({ tick: t + 1, dur: dur + 50, pitch: notes.at(-1).pitch, vel: 90 });   // 同音高重疊
      t += Math.max(style === 'random' ? 0 : 1, step);
      if (r() < 0.02) t += int(r, 10, 30) * beat;   // 長空白
    }
    if (!notes.length) notes.push({ tick: 0, dur: beat, pitch: 60 });
    parts.push(r() < 0.12 ? { channel: 9, notes: notes.map((n) => ({ ...n, pitch: 35 + (n.pitch % 20) })) } : { program: int(r, 0, 127), notes });
  }
  return { ppq, smpte, tempos, timeSigs, parts };
}

const BEHAVIORS = ['score', 'scoreSlow', 'scoreFast', 'beat', 'onset', 'mash', 'leaves', 'never', 'sloppy'];
function botFor(r, slot, behavior, seed) {
  const source = slot === 'kb' ? 'keyboard' : 'gesture';
  switch (behavior) {
    case 'score': return scoreBot(slot, { jitterMs: int(r, 0, 60), seed, source });
    case 'scoreSlow': return scoreBot(slot, { factor: 0.5 + r() * 0.3, jitterMs: 40, seed, source });
    case 'scoreFast': return scoreBot(slot, { factor: 1.3 + r() * 0.5, jitterMs: 30, seed, source });
    case 'beat': return beatBot(slot, { jitterMs: int(r, 0, 60), seed, source });
    case 'onset': return scoreBot(slot, { jitterMs: 20, seed, source, retryMs: 120 });   // 照每個音按、跟著聽到的音樂（閉迴路；開迴路的 onsetBot 被擋幾下就會跟音樂脫節）
    case 'mash': return mashBot(slot, { fromMs: int(r, 1000, 4000), toMs: int(r, 5000, 12000), periodMs: int(r, 60, 200), seed, source });
    case 'leaves': return scoreBot(slot, { jitterMs: 30, seed, source, stopAtMs: int(r, 2000, 6000), resumeAtMs: r() < 0.5 ? int(r, 8000, 15000) : null });
    case 'never': return null;
    default: return scoreBot(slot, { jitterMs: 80, miss: 0.2, extra: 0.15, seed, source });
  }
}

/** 一個模糊案例：回傳 { sim, desc }（還沒跑） */
export function fuzzCase(seed) {
  const spec = fuzzSpec(seed);
  const r = rng(seed * 104729 + 7);
  const score = parseMidi(buildMidi(spec));
  const slots = ['kb', 1, 2, 3, 4].filter(() => r() < 0.6);
  if (!slots.length) slots.push(pick(r, ['kb', 1]));
  const perPart = score.parts.map(() => (r() < 0.75 ? pick(r, slots) : undefined));
  const modes = Object.fromEntries(slots.map((s) => [s, pick(r, ['auto', 'onset', 'beat', 'musician'])]));
  const sim = createSim(score, assign(score, perPart), { modes });
  const behaviors = {};
  for (const s of slots) {
    const b = pick(r, BEHAVIORS);
    behaviors[s] = b;
    const bot = botFor(r, s, b, seed * 8 + slots.indexOf(s));   // 每個人自己的亂數：同樣行為的兩個人不會在同一刻漏按、同樣抖動
    if (bot && sim.sched.inspect().groups.some((g) => g.slot === s)) sim.addBot(bot);
  }
  // 在場名單：從沒來的人不在鏡頭裡；揮手的人停手（亂按完、離開）的那一刻也走出鏡頭（真人停下來多半就是走開了），離開又回來的人回來時回到鏡頭
  const presentSet = new Set(slots.filter((s) => typeof s === 'number' && behaviors[s] !== 'never'));
  sim.sched.setPresence([...presentSet], sim.now);
  const changes = [];
  for (const s of presentSet) {
    const b = sim.bots.find((x) => x.slot === s);
    if (!b) continue;
    if (behaviors[s] === 'mash') changes.push([b.stopMs ?? Infinity, s, false]);
    if (behaviors[s] === 'leaves') { changes.push([b.stopAtMs, s, false]); if (b.resumeAtMs) changes.push([b.resumeAtMs, s, true]); }
  }
  changes.sort((a, b) => a[0] - b[0]);
  let ci = 0;
  sim.addBot({
    slot: null, lagMs: 0,
    nextAt() { return ci < changes.length && Number.isFinite(changes[ci][0]) ? changes[ci][0] : null; },
    fire(x) { const [, s, on] = changes[ci++]; if (on) presentSet.add(s); else presentSet.delete(s); x.sched.setPresence([...presentSet], x.now); },
  });
  // 該不該奏完：至少一個有聲部的人一直彈到最後（照音符、照拍子、亂但沒停、離開又回來）。沒有人彈到最後時合奏照規則停著等他（不自動播），不算錯
  const keepsPlaying = (b) => ['score', 'scoreSlow', 'scoreFast', 'beat', 'onset', 'sloppy'].includes(b);
  const assigned = new Set(sim.sched.inspect().groups.filter((g) => g.slot !== null).map((g) => g.slot));
  // 而且停手的人不會讓合奏停著等：揮手的人停手就離開鏡頭（由電腦代打）；鍵盤手停手、人還在，合奏照規則等他
  const blocks = (s) => s === 'kb' && !keepsPlaying(behaviors[s]) && behaviors[s] !== 'never';
  const expectFinish = [...assigned].some((s) => keepsPlaying(behaviors[s])) && ![...assigned].some(blocks);
  // 播完的上限：曲長的 3 倍＋60 秒（很慢的人、長空白），而且一個起音至少給 1 秒（很密的聲部一拍按一下、一下只放一個音，本來就會比曲長久很多）
  const onsets = Math.max(0, ...sim.sched.inspect().groups.filter((g) => g.slot !== null).map((g) => g.segments.length));
  const limitMs = (score.durationSeconds * 3 + 60 + onsets) * 1000;
  return { sim, score, expectFinish, limitMs, desc: { seed, ppq: spec.ppq, smpte: !!spec.smpte, tempos: spec.tempos.map((t) => t.bpm), sigs: spec.timeSigs.map((t) => `${t.num}/${t.den}`), parts: spec.parts.length, perPart, modes, behaviors, durationSec: Math.round(score.durationSeconds) } };
}
