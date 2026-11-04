// gen-baseline.mjs — 產生「單人、起音模式」的手感基準：node test/tools/gen-baseline.mjs <src 目錄> <輸出檔>
// 用原本的程式（基準 commit 的 src/）跑同一組機器人，記下每一次合成器呼叫的時刻（不含力度：力度在階段 2 刻意改變）。
// 測試（test/baseline.test.mjs）用目前的程式重跑、逐筆比對，證明單人起音模式的時刻一筆都沒變。
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { baselineRuns } from '../helpers/baseline.js';

const [srcDir, out] = process.argv.slice(2);
const { Scheduler } = await import(pathToFileURL(resolve(srcDir, 'midi/scheduler.js')).href);
const runs = baselineRuns(Scheduler);
writeFileSync(out, gzipSync(JSON.stringify(runs)));
console.log('runs', Object.keys(runs).length, 'calls', Object.values(runs).reduce((a, r) => a + r.calls.length, 0));
