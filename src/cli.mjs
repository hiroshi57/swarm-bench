#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sweep, verifierSweep } from './bench.mjs';
import { calibrate, simulate, DEFAULTS } from './model.mjs';
import { renderHtml, renderMarkdown } from './report.mjs';

const HELP = `
swarm-bench — 1体 vs 10体 vs 100体。台数を増やすと何が起きるかを測る

  swarm-bench sweep [--n 1,2,4,8,16,32,64,100] [--trials 20] [--verifiers 1] [--out out]
  swarm-bench verifiers --workers 32 [--v 1,2,4,8]
  swarm-bench one --workers 16 [--seed 1]
  swarm-bench calibrate <board.jsonl> [...]      実測からモデルを較正する
  swarm-bench params                             既定パラメータを表示

モデルのパラメータは --pComplete 0.7 のように名前で上書きできる。

注意: sweep はシミュレーションであって実測ではない。
     必ず自分のボードで calibrate してから使うこと。
`.trim();

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const num = (n, d) => {
  const v = opt(n, null);
  if (v === null) return d;
  const x = Number(v);
  if (!Number.isFinite(x)) { console.error(`--${n} は数値である必要があります: ${v}`); process.exit(2); }
  return x;
};
const list = (n, d) => {
  const v = opt(n, null);
  if (v === null) return d;
  const xs = v.split(',').map((s) => Number(s.trim()));
  if (xs.some((x) => !Number.isInteger(x) || x < 1)) { console.error(`--${n} は 1 以上の整数のカンマ区切りが必要です`); process.exit(2); }
  return xs;
};
/** モデルパラメータの上書きを拾う */
const overrides = () => {
  const o = {};
  for (const k of Object.keys(DEFAULTS)) if (has(k)) o[k] = num(k, DEFAULTS[k]);
  return o;
};

if (!cmd || has('help') || cmd === 'help') { console.log(HELP); process.exit(cmd ? 0 : 2); }

if (cmd === 'params') {
  for (const [k, v] of Object.entries(DEFAULTS)) console.log(`  --${k.padEnd(22)} ${v}`);
  process.exit(0);
}

if (cmd === 'calibrate') {
  const files = argv.slice(1).filter((a) => !a.startsWith('--'));
  if (files.length === 0) { console.error('使い方: swarm-bench calibrate <board.jsonl> [...]'); process.exit(2); }
  const c = calibrate(files.map((f) => readFileSync(f, 'utf8')));
  if (has('json')) { console.log(JSON.stringify(c, null, 2)); process.exit(c.ok ? 0 : 1); }
  if (!c.ok) { console.error(`較正できません: ${c.reason}`); process.exit(1); }
  console.log(`\n${c.boards} 本のボード / ${c.samples} 投稿 / ${c.rounds ?? '?'} ラウンド\n`);
  console.log('観測:');
  console.log(`  verify_result  pass ${c.observed.verdicts.pass} / needs_changes ${c.observed.verdicts.needs_changes} / fail ${c.observed.verdicts.fail}`);
  console.log(`  done ${c.observed.dones} / assign ${c.observed.assigns} / answer ${c.observed.answers} / verifier ${c.observed.verifiers} 体`);
  console.log('\n推定パラメータ（sweep にそのまま渡せる）:');
  const flags = Object.entries(c.suggested).map(([k, v]) => `--${k} ${v}`).join(' ');
  console.log(`  ${flags || '(推定できた値がありません)'}`);
  console.log('\n注意:');
  for (const n of c.notes) console.log(`  - ${n}`);
  process.exit(0);
}

if (cmd === 'one') {
  const r = simulate({ workers: num('workers', 8), verifiers: num('verifiers', 1), seed: num('seed', 1), ...overrides() });
  const { perRound, ...rest } = r;
  console.log(JSON.stringify(rest, null, 2));
  process.exit(0);
}

if (cmd === 'verifiers') {
  const workers = num('workers', 32);
  const rows = verifierSweep({ workers, verifierValues: list('v', [1, 2, 4, 8]), trials: num('trials', 20), ...overrides() });
  console.log(`\nworker ${workers} 体のまま verifier だけ増やす\n`);
  console.log('  verifier  ラウンド   品質    正味成果   見逃し   コスト');
  for (const r of rows) {
    console.log(`  ${String(r.verifiers).padStart(8)}  ${String(r.rounds.mean).padStart(8)}  ${r.quality.mean.toFixed(3)}  ${r.goodput.mean.toFixed(3).padStart(8)}  ${r.escapedDefects.toFixed(1).padStart(7)}  $${r.usd.mean.toFixed(2).padStart(7)}`);
  }
  const best = rows.reduce((a, b) => (b.goodput.mean > a.goodput.mean ? b : a));
  console.log(`\n  正味成果が最大なのは verifier ${best.verifiers} 体`);
  process.exit(0);
}

if (cmd !== 'sweep') { console.error(`未知のコマンド '${cmd}'\n\n${HELP}`); process.exit(2); }

const nValues = list('n', [1, 2, 4, 8, 16, 32, 64, 100]);
const result = sweep({
  nValues,
  verifiers: num('verifiers', 1),
  trials: num('trials', 20),
  ...overrides(),
});

console.log(`\n台数掃引（各 ${result.trials} 試行 / verifier ${result.verifiers} 体）`);
console.log('※ これはモデルによる推計であって実測ではない。calibrate で自分のボードに合わせること\n');
console.log('  worker  ラウンド(95%CI)        速度   品質           正味成果  コスト      倍率  見逃し');
for (const p of result.points) {
  console.log(
    `  ${String(p.workers).padStart(6)}  ${String(p.rounds.mean).padStart(6)} ±${String(p.rounds.ci95).padEnd(6)}  `
    + `${(p.speedup + 'x').padStart(6)}  ${p.quality.mean.toFixed(3)}±${p.quality.ci95.toFixed(3)}  `
    + `${p.goodput.mean.toFixed(3).padStart(8)}  $${p.usd.mean.toFixed(2).padStart(8)}  ${(p.costMultiple + 'x').padStart(7)}  ${p.escapedDefects.toFixed(1).padStart(5)}`,
  );
}

const v = result.verdict;
console.log('\n判定:');
console.log(`  いちばん速い        ${v.bestSpeedWorkers} 体（${v.maxSpeedup} 倍速 / コスト ${v.costAtMaxSpeed} 倍）`);
console.log(`  いちばん品質が高い   ${v.bestQualityWorkers} 体`);
console.log(`  費用対効果が最良     ${v.bestValueWorkers} 体`);
console.log(`  速度の飽和点        ${v.saturationWorkers} 体`);
console.log(`  品質が崩れ始める点   ${v.qualityBreaksAt ?? '測った範囲では見られない'}`);

console.log('\n所見:');
for (const f of result.findings) {
  console.log(`  ${{ key: '*', warn: '!', ok: '✓' }[f.level]} ${f.text}`);
  if (f.why) console.log(`      なぜ: ${f.why}`);
}

const outDir = opt('out', null);
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  writeFileSync(join(outDir, 'report.md'), renderMarkdown(result), 'utf8');
  writeFileSync(join(outDir, 'index.html'), renderHtml(result), 'utf8');
  console.log(`\n出力: ${join(outDir, 'index.html')}`);
}
