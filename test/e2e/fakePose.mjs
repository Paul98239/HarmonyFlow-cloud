// fakePose.mjs — 端到端測試用的假姿勢推論：把 src/vision/poseWorker.js 換成一個照腳本回傳骨架的 Worker（MediaPipe 本身不動、也不載入）。
// 頁面裡用 window.__fakePose.set(people) 改腳本（經 BroadcastChannel 傳給 Worker）。people：[{ cx, cy, scale, amp, periodMs, faceVisible, present, seated, phaseMs }]，
// 座標是正規化座標，scale＝肩寬（畫面寬為單位），amp＝揮手深度（尺度單位），present:false＝這個人不在（不回傳）。

const WORKER_SRC = `
const ASPECT = 9 / 16;
let people = [];
const ch = new BroadcastChannel('fake-pose');
ch.onmessage = (e) => { people = e.data; };
function wave(t, amp, periodMs, phaseMs) {
  const ph = ((t + phaseMs) % periodMs) / periodMs;
  const x = 0.6 + 0.6 * Math.sin(2 * Math.PI * ph);
  const half = (ph * 2) % 1;
  return { x, y: 0.6 - amp / 2 + amp * Math.sin(Math.PI * half) };
}
function body(p, t) {
  const { cx = 0.5, cy = 0.4, scale = 0.15, amp = 1, periodMs = 1200, faceVisible = true, seated = false, phaseMs = 0 } = p;
  const pt = (dx, dy, vis = true) => ({ x: cx + dx * scale, y: cy + (dy * scale) / ASPECT, z: 0, visibility: vis ? 0.95 : 0.05, presence: vis ? 0.95 : 0.05 });
  const w = amp > 0 ? wave(t, amp, periodMs, phaseMs) : { x: 0.6, y: 1.5 };
  const lw = { x: -0.6, y: 1.5 };
  const lm = [];
  for (let i = 0; i < 11; i++) lm.push(pt((i % 3 - 1) * 0.1, -0.9 + (i > 8 ? 0.25 : 0), faceVisible));
  lm.push(pt(-0.5, 0), pt(0.5, 0));
  lm.push(pt((-0.5 + lw.x) / 2 - 0.1, lw.y / 2), pt((0.5 + w.x) / 2 + 0.1, w.y / 2));
  lm.push(pt(lw.x, lw.y), pt(w.x, w.y));
  lm.push(pt(lw.x - 0.08, lw.y + 0.12), pt(w.x + 0.08, w.y + 0.12), pt(lw.x - 0.08, lw.y + 0.12), pt(w.x + 0.08, w.y + 0.12), pt(lw.x - 0.08, lw.y + 0.12), pt(w.x + 0.08, w.y + 0.12));
  lm.push(pt(-0.35, 1.7, !seated), pt(0.35, 1.7, !seated));
  for (let i = 25; i < 33; i++) lm.push(pt(i % 2 ? -0.35 : 0.35, 2.6 + (i - 25) * 0.2, !seated));
  return lm;
}
self.onmessage = ({ data: msg }) => {
  if (msg.type === 'configure') { self.postMessage({ type: 'configured', id: msg.id, modelIndex: 0 }); return; }
  if (msg.type === 'detect') {
    msg.bitmap?.close?.();
    msg.frame?.close?.();
    const t = performance.now();
    const landmarks = people.filter((p) => p.present !== false).map((p) => body(p, t));
    setTimeout(() => self.postMessage({ type: 'result', ts: msg.ts, inferMs: 4, landmarks, worldLandmarks: [] }), 4);
  }
};
self.postMessage({ type: 'ready' });
`;

/** 在頁面載入前裝上：之後 new Worker(…poseWorker.js) 會拿到假的 Worker；window.__fakePose.set(people) 改腳本 */
export async function installFakePose(page, people = []) {
  await page.addInitScript(({ src, initial }) => {
    const RealWorker = window.Worker;
    const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    window.Worker = function (url, opts) {
      if (String(url).includes('poseWorker.js')) return new RealWorker(blobUrl, { type: 'module' });
      return new RealWorker(url, opts);
    };
    const ch = new BroadcastChannel('fake-pose');
    window.__fakePose = { people: initial, set(people) { this.people = people; ch.postMessage(people); } };
    // Worker 起來之後把目前的腳本送一次（BroadcastChannel 不保留舊訊息）
    setInterval(() => ch.postMessage(window.__fakePose.people), 500);
  }, { src: WORKER_SRC, initial: people });
}
