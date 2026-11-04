// pose.js — 合成的骨架（tracking.js 的 track 形狀：smoothed 33 點、scale、aspect）與手腕軌跡，給手勢、表情、追蹤的測試用。
// 座標是正規化座標（0～1）；scale＝肩寬（以畫面寬為單位），aspect＝高 ÷ 寬（16:9 是 0.5625）。

export const ASPECT = 9 / 16;

/**
 * 一個人的一幀骨架：肩膀中點 (cx, cy)、肩寬 scale；手腕相對肩膀的位置（尺度單位，右／下為正）lw、rw；seated＝髖以下看不到。
 */
export function body({ cx = 0.5, cy = 0.4, scale = 0.15, lw = { x: -0.9, y: 1.6 }, rw = { x: 0.9, y: 1.6 }, seated = false, faceVisible = true } = {}) {
  const pt = (dx, dy, visible = true) => ({ x: cx + dx * scale, y: cy + (dy * scale) / ASPECT, visible, visibility: visible ? 0.95 : 0.1, presence: visible ? 0.95 : 0.1, z: 0 });
  const lm = Array.from({ length: 33 }, () => pt(0, 0, false));
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) lm[i] = pt((i % 3 - 1) * 0.1, -0.9 + (i > 8 ? 0.25 : 0), faceVisible);
  lm[11] = pt(-0.5, 0); lm[12] = pt(0.5, 0);
  // 手肘在肩膀與手腕之間
  lm[13] = pt((-0.5 + lw.x) / 2 - 0.1, lw.y / 2); lm[14] = pt((0.5 + rw.x) / 2 + 0.1, rw.y / 2);
  lm[15] = pt(lw.x, lw.y); lm[16] = pt(rw.x, rw.y);
  for (const [i, w, s] of [[17, lw, -1], [19, lw, -1], [21, lw, -1], [18, rw, 1], [20, rw, 1], [22, rw, 1]]) lm[i] = pt(w.x + s * 0.08, w.y + 0.12);
  lm[23] = pt(-0.35, 1.7, !seated); lm[24] = pt(0.35, 1.7, !seated);
  for (const i of [25, 26, 27, 28, 29, 30, 31, 32]) lm[i] = pt(i % 2 ? -0.35 : 0.35, 2.6 + (i - 25) * 0.2, !seated);
  return lm;
}

export const trackOf = (lm, scale) => ({ smoothed: lm, raw: lm, scale, aspect: ASPECT });

/**
 * 揮手：右手腕在肩膀前方左右來回、每半個週期往下沉一次（拋物線）；amp＝下沉深度（尺度單位）、spanX＝左右幅度、periodMs＝來回一次的時間。
 * 回傳 t → 右手腕相對肩膀的位置（尺度單位）
 */
export function waveAt(t, { amp = 1, spanX = 1.2, periodMs = 1200, restY = 0.6 } = {}) {
  const ph = (t % periodMs) / periodMs;
  const x = 0.6 + (spanX / 2) * Math.sin(2 * Math.PI * ph);
  const half = (ph * 2) % 1;
  const y = restY - amp / 2 + amp * Math.sin(Math.PI * half);   // 從高處下沉到最低點再回升
  return { x, y };
}
