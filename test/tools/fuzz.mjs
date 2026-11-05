// fuzz.mjs — 跑模糊測試：node test/tools/fuzz.mjs [起始種子] [個數]（或 node test/tools/fuzz.mjs 種子 1 重現單一個案例）
import { fuzzCase } from '../helpers/fuzz.js';
import { violations } from '../helpers/scenarios.js';

const from = Number(process.argv[2] ?? 1), count = Number(process.argv[3] ?? 100);
let bad = 0;
const t0 = Date.now();
for (let seed = from; seed < from + count; seed++) {
  let desc = null, v;
  try {
    const c = fuzzCase(seed);
    desc = c.desc;
    // 播完的上限見 fuzzCase 的 limitMs
    c.sim.runToEnd(c.limitMs);
    v = violations(c.sim, { finished: c.expectFinish });
    // 沒奏完時（停著等人）hold 著的音本來就還在響：不算卡音
    if (!c.sim.sched.isFinished()) v = v.filter((x) => !x.startsWith('卡音'));
  } catch (err) {
    v = [`例外：${String(err?.stack ?? err).split('\n').slice(0, 4).join(' ← ')}`];
  }
  if (v.length) { bad++; console.log(`種子 ${seed}：${v.join('；')}\n  ${JSON.stringify(desc)}`); }
}
console.log(`${count} 個案例，${bad} 個有問題（${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
process.exit(bad ? 1 : 0);
