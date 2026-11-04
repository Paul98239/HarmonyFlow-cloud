// smf.js — 測試用的 Standard MIDI File 產生器：把簡單的音符清單寫成 SMF 位元組，交給 src/midi/midiParser.js 解析。
// 只寫解析器需要的東西（速度、拍號、program、音符、可選的控制器），不模仿任何一首真實的歌。

const vlq = (n) => {
  const bytes = [n & 0x7f];
  while ((n >>= 7) > 0) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
};
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n) => [(n >>> 8) & 0xff, n & 0xff];

function trackChunk(events) {
  // events：{ tick, bytes, order }，依 tick、再依 order（同 tick 時 note off 在 note on 前面）排
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const data = [];
  let last = 0;
  for (const e of events) {
    data.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  data.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(data.length), ...data];
}

/**
 * @param {object} spec
 * @param {number} [spec.ppq=480]  每四分音符 tick 數；給 smpte 時忽略
 * @param {{ fps: 24|25|29|30, tpf: number }} [spec.smpte]  SMPTE division（沒有四分音符）
 * @param {{ tick: number, bpm: number }[]} [spec.tempos]
 * @param {{ tick: number, num: number, den: number, cc?: number }[]} [spec.timeSigs]  沒給就不寫拍號（解析器補 4/4）
 * @param {{ program?: number, channel?: number, notes: { tick: number, dur: number, pitch: number, vel?: number }[], controls?: { tick: number, cc: number, value: number }[] }[]} spec.parts
 *   每個 part 一軌、一個 channel
 * @returns {Uint8Array}
 */
export function buildMidi({ ppq = 480, smpte = null, tempos = [{ tick: 0, bpm: 120 }], timeSigs = [], parts }) {
  const division = smpte ? [(256 - smpte.fps) & 0xff, smpte.tpf] : u16(ppq);
  const conductor = [];
  for (const t of tempos) {
    const us = Math.round(60e6 / t.bpm);
    conductor.push({ tick: t.tick, order: 0, bytes: [0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] });
  }
  for (const s of timeSigs) {
    const dd = Math.round(Math.log2(s.den));
    conductor.push({ tick: s.tick, order: 0, bytes: [0xff, 0x58, 4, s.num, dd, s.cc ?? 24, 8] });
  }
  const chunks = [trackChunk(conductor)];
  parts.forEach((part, i) => {
    const ch = part.channel ?? (i >= 9 ? i + 1 : i);
    const ev = [{ tick: 0, order: 1, bytes: [0xc0 | ch, part.program ?? 0] }];
    for (const c of part.controls ?? []) ev.push({ tick: c.tick, order: 1, bytes: [0xb0 | ch, c.cc, c.value] });
    for (const n of part.notes) {
      ev.push({ tick: n.tick, order: 2, bytes: [0x90 | ch, n.pitch, n.vel ?? 80] });
      ev.push({ tick: n.tick + n.dur, order: 0, bytes: [0x80 | ch, n.pitch, 0] });
    }
    chunks.push(trackChunk(ev));
  });
  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(chunks.length), ...division];
  return new Uint8Array([...header, ...chunks.flat()]);
}

/** 一串等長音符：從 tick 起每 step 一顆，音高照 pitches 循環 */
export function run(tick, count, step, pitches, { dur = step, vel = 80 } = {}) {
  return Array.from({ length: count }, (_, i) => ({ tick: tick + i * step, dur, pitch: pitches[i % pitches.length], vel }));
}
