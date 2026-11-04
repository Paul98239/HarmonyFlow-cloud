// 單人、起音模式的手感不能改變：用目前的程式重跑基準（test/helpers/baseline.js），每一次合成器呼叫的時刻、音高、時間戳都要跟原本的程式（fixture）一樣。
// 力度不比（階段 2 刻意依按鍵位置、揮手改變它）。基準是用原本的 commit 產生的：node test/tools/gen-baseline.mjs <原本的 src> test/fixtures/onset-single-baseline.json.gz
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Scheduler } from '../src/midi/scheduler.js';
import { baselineRuns } from './helpers/baseline.js';

const expected = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/onset-single-baseline.json.gz', import.meta.url))).toString());

test('單人起音模式：合成器呼叫的時刻與音高跟原本的程式逐筆相同', () => {
  const actual = baselineRuns(Scheduler);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const [name, exp] of Object.entries(expected)) {
    const got = actual[name];
    assert.equal(got.finished, exp.finished, `${name}：播完與否不同`);
    const n = Math.max(got.calls.length, exp.calls.length);
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(got.calls[i]) !== JSON.stringify(exp.calls[i])) {
        assert.fail(`${name}：第 ${i} 筆呼叫不同\n  原本：${JSON.stringify(exp.calls[i])}\n  現在：${JSON.stringify(got.calls[i])}`);
      }
    }
  }
});
