// songs.js — 測試樂譜（合成的測資，不是真實曲目）：每一首針對一種會讓演奏規則出錯的結構。
// 規則要對任何 MIDI 成立，所以測試是跑「整個測資庫」，不針對某一首調參數。亂數用固定種子，每次產生的檔案相同。

import { buildMidi, run } from './smf.js';
import { parseMidi } from '../../src/midi/midiParser.js';

export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const Q = 480;   // 四分音符

// 兩聲部：旋律四分＋八分、低音二分，4/4、100 BPM
function duet() {
  const mel = [];
  for (let bar = 0; bar < 8; bar++) {
    const t = bar * 4 * Q;
    mel.push(...run(t, 2, Q, [72, 74]), ...run(t + 2 * Q, 4, Q / 2, [76, 74, 72, 71]));
  }
  const bass = run(0, 16, 2 * Q, [48, 43, 45, 41]);
  return { tempos: [{ tick: 0, bpm: 100 }], timeSigs: [{ tick: 0, num: 4, den: 4 }], parts: [{ program: 0, notes: mel }, { program: 32, notes: bass }] };
}

// 快音群：十六分、三十二分、六十四分顫音、倚音（10 tick 前的裝飾音）、五連音
function fastRuns() {
  const mel = [];
  let t = 0;
  mel.push(...run(t, 4, Q, [67, 69, 71, 72])); t += 4 * Q;
  mel.push(...run(t, 16, Q / 4, [72, 74, 76, 77, 79, 77, 76, 74])); t += 4 * Q;          // 十六分
  mel.push(...run(t, 32, Q / 8, [79, 77, 76, 74])); t += 4 * Q;                           // 三十二分
  mel.push(...run(t, 64, Q / 16, [76, 77])); t += 4 * Q;                                  // 六十四分顫音（一小節）
  mel.push({ tick: t - 10, dur: 10, pitch: 74 }, { tick: t, dur: Q, pitch: 72 });        // 倚音
  mel.push(...run(t + Q, 5, Math.round(Q / 5), [72, 74, 76, 77, 79])); t += 2 * Q;        // 五連音
  mel.push(...run(t, 2, Q, [72, 67])); t += 2 * Q;
  const acc = run(0, (t / Q) | 0, Q, [48, 55, 52, 55]);
  return { tempos: [{ tick: 0, bpm: 96 }], timeSigs: [{ tick: 0, num: 4, den: 4 }], parts: [{ program: 73, notes: mel }, { program: 0, notes: acc }] };
}

// 弱起：旋律從第 0 小節第 4 拍進來（整首仍從 tick 0 起算），伴奏從第 1 小節開始
function pickup() {
  const mel = [...run(3 * Q, 1, Q, [67]), ...run(4 * Q, 12, Q, [72, 71, 69, 67, 69, 71])];
  const acc = run(4 * Q, 6, 2 * Q, [48, 43, 48]);
  return { tempos: [{ tick: 0, bpm: 90 }], timeSigs: [{ tick: 0, num: 4, den: 4 }], parts: [{ program: 0, notes: mel }, { program: 0, notes: acc }] };
}

// 不規則小節：4/4 → 5/8 → 7/8 → 3/4，中途變速
function irregular() {
  const sigs = [{ tick: 0, num: 4, den: 4 }, { tick: 4 * Q, num: 5, den: 8 }, { tick: 4 * Q + 5 * Q / 2, num: 7, den: 8 }, { tick: 4 * Q + 6 * Q, num: 3, den: 4 }];
  const mel = [...run(0, 8, Q / 2, [60, 62, 64, 65]), ...run(4 * Q, 5, Q / 2, [67, 65, 64, 62, 60]), ...run(4 * Q + 5 * Q / 2, 7, Q / 2, [60, 62, 64, 65, 67, 69, 71]), ...run(10 * Q, 6, Q / 2, [72, 71, 69, 67, 65, 64])];
  const acc = run(0, 13, Q, [36, 43]);
  return { tempos: [{ tick: 0, bpm: 110 }, { tick: 10 * Q, bpm: 80 }], timeSigs: sigs, parts: [{ program: 40, notes: mel }, { program: 42, notes: acc }] };
}

// 未量化的錄製檔：沒有拍號、預設 120 BPM，演奏者實際的速度約 76 BPM 並有快慢，音符時刻有抖動
function unquantized() {
  const r = rng(7), mel = [], acc = [];
  let t = 37;   // 不從 0 開始
  for (let i = 0; i < 40; i++) {
    const beat = Math.round(Q * (120 / 76) * (0.85 + 0.3 * r()));
    const dur = Math.round(beat * (0.6 + 0.35 * r()));
    mel.push({ tick: t + Math.round((r() - 0.5) * 60), dur, pitch: 60 + ((i * 5) % 12), vel: 50 + Math.round(r() * 60) });
    if (i % 2 === 0) acc.push({ tick: t + Math.round((r() - 0.5) * 80), dur: beat * 2 - 20, pitch: 36 + (i % 7), vel: 60 });
    if (r() < 0.25) mel.push({ tick: t + (beat >> 1) + Math.round((r() - 0.5) * 30), dur: beat >> 2, pitch: 67, vel: 70 });
    t += beat;
  }
  mel.sort((a, b) => a.tick - b.tick);
  return { tempos: [{ tick: 0, bpm: 120 }], parts: [{ program: 0, notes: mel }, { program: 0, notes: acc }] };
}

// SMPTE：25 fps × 40 tick（每秒 1000 tick），沒有四分音符
function smpte() {
  const mel = run(0, 24, 400, [64, 66, 68, 69], { dur: 380 });
  mel.push(...run(24 * 400, 8, 100, [71, 73]));   // 快音
  const acc = run(0, 14, 800, [40, 45, 47]);
  return { smpte: { fps: 25, tpf: 40 }, parts: [{ program: 0, notes: mel }, { program: 0, notes: acc }] };
}

// 卡農：伴奏先進兩小節，旋律後進（前奏鎖）；旋律有長休止（休止符鎖）
function canonRests() {
  const lead = run(0, 24, Q, [48, 55, 52, 57, 53, 48]);
  const mel = [...run(8 * Q, 6, Q, [72, 74, 76, 77, 76, 74]), ...run(18 * Q, 6, Q, [72, 71, 69, 67, 65, 64])];   // 第 14～18 拍休止 4 拍
  return { tempos: [{ tick: 0, bpm: 100 }], timeSigs: [{ tick: 0, num: 4, den: 4 }], parts: [{ program: 42, notes: lead }, { program: 40, notes: mel }] };
}

// 四聲部合唱：四個 part 節奏各不相同（給 PC 鍵盤手＋演奏者 1～3）
function quartet() {
  const s = [], a = [], tn = [], b = [];
  for (let bar = 0; bar < 6; bar++) {
    const t = bar * 4 * Q;
    s.push(...run(t, 4, Q, [76, 77, 79, 77]));
    a.push(...run(t, 8, Q / 2, [67, 69, 71, 72]));
    tn.push(...run(t, 2, 2 * Q, [60, 62]));
    b.push(...run(t + Q / 2, 3, Q, [48, 50, 52]));   // 切分：從後半拍進
  }
  return { tempos: [{ tick: 0, bpm: 92 }], timeSigs: [{ tick: 0, num: 4, den: 4 }], parts: [52, 53, 54, 32].map((program, i) => ({ program, notes: [s, a, tn, b][i] })) };
}

// 鋼琴：同一軌兩個 channel 不同；和弦與長音底下的動音、延音踏板
function pianoChords() {
  const rh = [], lh = [];
  for (let bar = 0; bar < 6; bar++) {
    const t = bar * 4 * Q;
    for (const p of [72, 76, 79]) rh.push({ tick: t, dur: 2 * Q, pitch: p });
    rh.push(...run(t + 2 * Q, 4, Q / 2, [84, 83, 81, 79]));
    lh.push({ tick: t, dur: 4 * Q, pitch: 48 }, ...run(t + Q, 3, Q, [55, 52, 55], { dur: Q / 2 }));
  }
  const controls = [{ tick: 0, cc: 64, value: 127 }, { tick: 8 * Q - 10, cc: 64, value: 0 }, { tick: 8 * Q, cc: 64, value: 127 }];
  return { tempos: [{ tick: 0, bpm: 84 }], timeSigs: [{ tick: 0, num: 4, den: 4 }], parts: [{ program: 0, notes: rh, controls }, { program: 0, notes: lh }] };
}

// 鼓＋貝斯：打擊在 channel 9
function drums() {
  const kit = [];
  for (let i = 0; i < 32; i++) kit.push({ tick: i * Q / 2, dur: 60, pitch: i % 4 === 0 ? 36 : i % 4 === 2 ? 38 : 42 });
  const bass = run(0, 16, Q, [40, 40, 43, 45]);
  return { tempos: [{ tick: 0, bpm: 120 }], timeSigs: [{ tick: 0, num: 4, den: 4 }], parts: [{ channel: 9, notes: kit }, { program: 33, notes: bass }] };
}

// 慢板長音：一拍很長（40 BPM、2/2），檢查一下不會自動放太久
function slowLong() {
  const mel = [...run(0, 4, 4 * Q, [60, 62, 64, 65]), ...run(16 * Q, 16, Q / 2, [67, 65, 64, 62])];
  const acc = run(0, 12, 2 * Q, [36, 43]);
  return { tempos: [{ tick: 0, bpm: 40 }], timeSigs: [{ tick: 0, num: 2, den: 2 }], parts: [{ program: 48, notes: mel }, { program: 48, notes: acc }] };
}

// 單聲部（沒有伴奏）
function solo() {
  return { tempos: [{ tick: 0, bpm: 120 }], timeSigs: [{ tick: 0, num: 3, den: 4 }], parts: [{ program: 0, notes: [...run(0, 12, Q, [60, 64, 67]), ...run(12 * Q, 12, Q / 2, [72, 71])] }] };
}

export const SONG_SPECS = { duet, fastRuns, pickup, irregular, unquantized, smpte, canonRests, quartet, pianoChords, drums, slowLong, solo };

// 另加一個伴奏聲部（放在最後）：每兩個相鄰起音（全曲合起來）之間的正中間放一顆音，長度到下一個起音為止。
// 這樣每一段兩下之間都有伴奏音在走，「伴奏擠成一團」「伴奏比帶頭的人晚」才量得出來（兩個聲部都被指派時本來沒有伴奏）。
function withAccompaniment(spec) {
  const onsets = [...new Set(spec.parts.flatMap((p) => p.notes.map((n) => n.tick)))].sort((a, b) => a - b);
  const notes = [];
  for (let i = 1; i < onsets.length; i++) {
    const g = onsets[i] - onsets[i - 1];
    if (g >= 40) notes.push({ tick: onsets[i - 1] + (g >> 1), dur: g - (g >> 1), pitch: 55 + (i % 5), vel: 60 });
  }
  return { ...spec, parts: [...spec.parts, { program: 89, channel: 15, notes }] };
}

/** 解析過的測資（每次呼叫重新解析，測試之間不共用物件）。accompaniment：另加一個伴奏聲部（見 withAccompaniment） */
export function loadSong(name, { accompaniment = false } = {}) {
  const spec = SONG_SPECS[name]();
  return parseMidi(buildMidi(accompaniment ? withAccompaniment(spec) : spec));
}

export const SONG_NAMES = Object.keys(SONG_SPECS);
