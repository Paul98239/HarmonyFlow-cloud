// crowd.js — 多人的合成場景，給追蹤（tracking.js）的測試：每個人的位置隨時間移動、可以被擋住（這一幀沒有偵測）、MediaPipe 的輸出順序每幀打亂、偶爾多吐一組幽靈骨架。
import { body, ASPECT } from './pose.js';
import { buildDetection, PersonTracker } from '../../src/vision/tracking.js';
import { rng } from './songs.js';

/**
 * 跑一個場景。people：[{ path: (t) => ({ cx, cy, scale }), visible?: (t, all) => boolean, faceVisible?: (t) => boolean }]；
 * 回傳每一幀每個人被哪個 ID（槽位＋1）追到：frames[i] = [ID 或 null, …]（依 people 順序），以及追蹤器的事件。
 */
export function runCrowd(people, { ms = 8000, fps = 30, maxUsers = people.length, seed = 5, ghosts = 0, jitter = 0.004, wave = true } = {}) {
  const r = rng(seed);
  const tracker = new PersonTracker({ maxUsers });
  const frames = [];
  for (let t = 0; t < ms; t += 1000 / fps) {
    const poses = people.map((p) => p.path(t));
    const dets = [];
    people.forEach((p, i) => {
      if (p.visible && !p.visible(t, poses)) return;
      const { cx, cy, scale } = poses[i];
      const ph = (t / 1100 + i * 0.3) % 1;
      const rw = wave ? { x: 0.6 + 0.6 * Math.sin(2 * Math.PI * ph), y: 0.6 + 0.8 * Math.sin(Math.PI * ((ph * 2) % 1)) } : { x: 0.9, y: 1.6 };
      const lm = body({ cx: cx + (r() - 0.5) * jitter, cy: cy + (r() - 0.5) * jitter, scale, rw, faceVisible: p.faceVisible ? p.faceVisible(t) : true });
      dets.push({ lm, who: i });
      if (ghosts && r() < ghosts) dets.push({ lm: body({ cx: cx + 0.01, cy: cy + 0.005, scale: scale * 0.97, rw }), who: i });
    });
    // MediaPipe 的輸出順序不固定
    for (let k = dets.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [dets[k], dets[j]] = [dets[j], dets[k]]; }
    const built = dets.map((d) => buildDetection(d.lm, { aspect: ASPECT })).filter(Boolean);
    tracker.update(built, t);
    const active = tracker.getActiveTracks();
    // 每個追到的 ID 屬於誰：離它的肩膀中點最近的那個真人
    const row = people.map(() => null);
    for (const tr of active) {
      let best = -1, bd = Infinity;
      poses.forEach((q, i) => { const d = Math.hypot(tr.centroid.x - q.cx, (tr.centroid.y - q.cy) * ASPECT); if (d < bd) { bd = d; best = i; } });
      if (best >= 0 && bd < poses[best].scale * 0.5) row[best] = row[best] === null ? tr.id : 'dup';
    }
    frames.push({ t, row });
  }
  return { frames, events: tracker.drainEvents() };
}

/** 每個人的 ID 有沒有換過（鎖定之後、看得到他的幀裡） */
export function idSwitches(frames) {
  const n = frames[0].row.length, first = Array(n).fill(null);
  let switches = 0, dups = 0;
  for (const { row } of frames) {
    row.forEach((id, i) => {
      if (id === 'dup') { dups++; return; }
      if (id === null) return;
      if (first[i] === null) first[i] = id;
      else if (first[i] !== id) switches++;
    });
  }
  return { switches, dups, first };
}
