// 輸出端的軟削波（synth.js 的 softClipCurve）：0.7 以下原樣（一般的歌聽起來一樣）、以上圓滑地壓、永遠不超過 1、單調、對稱
import test from 'node:test';
import assert from 'node:assert/strict';
import { softClipCurve } from '../src/midi/synth.js';

test('軟削波的曲線：膝點以下不變、以上不超過 1、單調、對稱', () => {
  const n = 8193, c = softClipCurve(n), range = 4;
  const at = (x) => c[Math.round(((x / range + 1) / 2) * (n - 1))];
  for (const x of [0, 0.1, 0.3, 0.5, 0.69]) assert.ok(Math.abs(at(x) - x) < 2e-3, `${x} → ${at(x)}`);
  for (const x of [0.8, 1, 1.67, 3, 4]) { assert.ok(at(x) <= 1 && at(x) > 0.7, `${x} → ${at(x)}`); }
  for (let i = 1; i < n; i++) assert.ok(c[i] >= c[i - 1], '單調');
  for (let i = 0; i < n; i++) assert.ok(Math.abs(c[i] + c[n - 1 - i]) < 1e-6, '對稱');
});
