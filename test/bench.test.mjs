import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { simulate, calibrate, rng, DEFAULTS } from '../src/model.mjs';
import { sweep, verifierSweep, stats } from '../src/bench.mjs';
import { renderMarkdown, renderHtml } from '../src/report.mjs';

const DEMO = 'C:/Users/hiroshi_takizawa/swarm-board-core/runs/demo3/board.jsonl';

// ---------- 乱数 ----------

test('rng は seed が同じなら同じ列を返す', () => {
  const a = Array.from({ length: 8 }, rng(42));
  const b = Array.from({ length: 8 }, rng(42));
  const c = Array.from({ length: 8 }, rng(43));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.ok(a.every((x) => x >= 0 && x < 1));
});

// ---------- シミュレーション ----------

test('simulate は決定論的（同じ入力なら完全に同じ結果）', () => {
  const a = simulate({ workers: 8, seed: 7 });
  const b = simulate({ workers: 8, seed: 7 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(simulate({ workers: 8, seed: 8 }).rounds, undefined);
});

test('simulate は必ず終端する（無限ループしない）', () => {
  for (const w of [1, 10, 100, 1000]) {
    const r = simulate({ workers: w, seed: 3 });
    assert.ok(r.rounds <= DEFAULTS.maxRounds, `workers=${w} が上限に達していない`);
    assert.ok(r.rounds >= 1);
  }
});

test('simulate は不正な引数を拒否する', () => {
  assert.throws(() => simulate({ workers: 0 }), RangeError);
  assert.throws(() => simulate({ workers: 2.5 }), RangeError);
  assert.throws(() => simulate({ workers: 4, verifiers: 0 }), RangeError);
});

test('指標が定義域に収まる', () => {
  for (const w of [1, 4, 16, 64]) {
    const r = simulate({ workers: w, seed: 11 });
    assert.ok(r.quality >= 0 && r.quality <= 1, `quality=${r.quality}`);
    assert.ok(r.goodput >= 0 && r.goodput <= 1);
    assert.ok(r.completion >= 0 && r.completion <= 1.0001);
    assert.ok(r.escapedDefects >= 0 && Number.isInteger(r.escapedDefects));
    assert.ok(r.input_tokens > 0 && r.output_tokens > 0);
    assert.equal(r.turns, r.turnsByRole.coordinator + r.turnsByRole.worker + r.turnsByRole.verifier);
  }
});

test('台数を増やすと最初は速くなる（並列化が効いている）', () => {
  const one = mean(5, (s) => simulate({ workers: 1, seed: s }).rounds);
  const eight = mean(5, (s) => simulate({ workers: 8, seed: s }).rounds);
  assert.ok(eight < one * 0.7, `1体 ${one} → 8体 ${eight} で十分に速くなっていない`);
});

test('Amdahl: 直列部分が大きいと台数を増やしても速くならない', () => {
  const opts = { subtasks: 48, serialFraction: 0.9 };
  const one = mean(5, (s) => simulate({ workers: 1, seed: s, ...opts }).rounds);
  const many = mean(5, (s) => simulate({ workers: 64, seed: s, ...opts }).rounds);
  assert.ok(many > one * 0.5, `直列 90% なのに ${one} → ${many} と速くなりすぎている`);
});

test('監督の帯域が並列度の上限になる', () => {
  const narrow = mean(5, (s) => simulate({ workers: 64, seed: s, coordinatorCapacity: 2, contention: 0 }).rounds);
  const wide = mean(5, (s) => simulate({ workers: 64, seed: s, coordinatorCapacity: 64, contention: 0 }).rounds);
  assert.ok(narrow > wide * 1.5, `監督の帯域を絞っても遅くならない（${wide} → ${narrow}）`);
});

test('検証の帯域が足りないと見逃しではなく待ち行列になる', () => {
  const slow = simulate({ workers: 32, verifiers: 1, verifierThroughput: 1, seed: 5 });
  const fast = simulate({ workers: 32, verifiers: 8, verifierThroughput: 8, seed: 5 });
  assert.ok(slow.rounds > fast.rounds, '検証が詰まれば所要は伸びるはず');
});

test('verifier の見抜く力を落とすと欠陥が市場に出る', () => {
  const good = mean(8, (s) => simulate({ workers: 8, seed: s, pCatch: 0.95 }).escapedDefects);
  const bad = mean(8, (s) => simulate({ workers: 8, seed: s, pCatch: 0.2 }).escapedDefects);
  assert.ok(bad > good * 2, `pCatch を下げても見逃しが増えない（${good} → ${bad}）`);
});

test('混線パラメータを 0 にすれば台数を増やしても完了率は落ちない', () => {
  const a = simulate({ workers: 100, seed: 2, contention: 0 });
  const b = simulate({ workers: 1, seed: 2, contention: 0 });
  assert.equal(a.effective.pComplete, b.effective.pComplete);
  assert.ok(simulate({ workers: 100, seed: 2, contention: 0.2 }).effective.pComplete < b.effective.pComplete);
});

test('掲示板の窓を絞るとトークンが減る', () => {
  const wide = simulate({ workers: 8, seed: 4, boardWindow: 1000 });
  const narrow = simulate({ workers: 8, seed: 4, boardWindow: 10 });
  assert.ok(narrow.input_tokens < wide.input_tokens);
});

// ---------- 掃引 ----------

test('sweep は各点に信頼区間つきの統計を返す', () => {
  const r = sweep({ nValues: [1, 4, 16], trials: 6 });
  assert.equal(r.points.length, 3);
  for (const p of r.points) {
    assert.equal(p.trials, 6);
    assert.ok(p.rounds.ci95 >= 0);
    assert.ok(p.rounds.lo <= p.rounds.mean && p.rounds.mean <= p.rounds.hi);
    assert.ok(p.usd.mean > 0, 'コストが計上されている');
  }
  assert.equal(r.points[0].speedup, 1, '基準点の速度倍率は 1');
});

test('sweep は飽和点・最良点・所見を出す', () => {
  const r = sweep({ nValues: [1, 2, 4, 8, 16, 32, 64, 100], trials: 8 });
  const v = r.verdict;
  assert.ok(r.points.some((p) => p.workers === v.bestValueWorkers));
  assert.ok(r.points.some((p) => p.workers === v.saturationWorkers));
  assert.ok(v.maxSpeedup >= 1);
  assert.ok(r.findings.length >= 2);
  for (const f of r.findings) {
    assert.ok(f.text.length > 10);
    assert.ok(['key', 'warn', 'ok'].includes(f.level));
  }
});

test('sweep: 台数を増やし続けても最速であり続けるとは限らない（逆U字を検出できる）', () => {
  const r = sweep({ nValues: [1, 4, 16, 64, 256], trials: 8, coordinatorCapacity: 8, contention: 0.12 });
  const best = r.verdict.bestSpeedWorkers;
  assert.ok(best < 256, `監督の帯域を絞っているのに最大台数が最速になっている（${best}）`);
});

test('sweep は不正な引数を拒否する', () => {
  assert.throws(() => sweep({ nValues: [] }), RangeError);
  assert.throws(() => sweep({ nValues: [4], trials: 0 }), RangeError);
});

test('verifierSweep は verifier 数ごとの行を返す', () => {
  const rows = verifierSweep({ workers: 16, verifierValues: [1, 2, 4], trials: 5 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.verifiers), [1, 2, 4]);
  assert.ok(rows.every((r) => r.goodput.mean >= 0 && r.goodput.mean <= 1));
});

test('stats: 95% 信頼区間が妥当', () => {
  const s = stats([10, 10, 10, 10]);
  assert.equal(s.mean, 10);
  assert.equal(s.sd, 0);
  assert.equal(s.ci95, 0);
  const t = stats([1, 2, 3, 4, 5]);
  assert.equal(t.mean, 3);
  assert.ok(t.ci95 > 0);
  assert.equal(t.min, 1);
  assert.equal(t.max, 5);
  assert.equal(stats([7]).ci95, 0, '1 サンプルでは区間を主張しない');
});

// ---------- 較正 ----------

test('calibrate: 空入力では ok:false を返す', () => {
  const c = calibrate([]);
  assert.equal(c.ok, false);
  assert.match(c.reason, /投稿/);
});

test('calibrate: 実際の board.jsonl からパラメータを推定する', { skip: !existsSync(DEMO) && 'デモボードが無い' }, () => {
  const c = calibrate([readFileSync(DEMO, 'utf8')]);
  assert.equal(c.ok, true);
  assert.equal(c.observed.verdicts.pass, 2);
  assert.equal(c.observed.verdicts.needs_changes, 1);
  assert.equal(c.observed.assigns, 3);
  assert.equal(c.rounds, 7, 'meta.round からラウンド数を復元できる');
  assert.ok(c.suggested.pDefect > 0);
  assert.ok(c.suggested.verifierThroughput >= 1);
  assert.ok(c.notes.some((n) => n.includes('下限')), '見逃しは観測できないことを明示する');
  assert.ok(c.notes.some((n) => n.includes('50 件')), 'サンプル不足を警告する');
});

test('calibrate: 壊れた行があっても続行する', () => {
  const text = '{"seq":1,"id":"p_0001","from":"@verifier","to":[],"type":"verify_result","verdict":"pass","ref":"p_0000","subject":"s","meta":{"round":1}}\nこわれた\n';
  const c = calibrate([text]);
  assert.equal(c.ok, true);
  assert.equal(c.samples, 1);
});

test('calibrate: verify_result が無ければ pDefect を推定しないと明言する', () => {
  const text = '{"seq":1,"id":"p_0001","from":"@human","to":[],"type":"note","subject":"s"}';
  const c = calibrate([text]);
  assert.equal(c.suggested.pDefect, undefined);
  assert.ok(c.notes.some((n) => n.includes('推定できません')));
});

test('較正した値を sweep にそのまま渡せる', { skip: !existsSync(DEMO) && 'デモボードが無い' }, () => {
  const c = calibrate([readFileSync(DEMO, 'utf8')]);
  const r = sweep({ nValues: [1, 8], trials: 4, ...c.suggested });
  assert.equal(r.points.length, 2);
  assert.ok(r.points.every((p) => p.rounds.mean > 0));
});

// ---------- 出力 ----------

test('レポートに「実測ではない」という断りが必ず入る', () => {
  const r = sweep({ nValues: [1, 8], trials: 4 });
  const md = renderMarkdown(r);
  const html = renderHtml(r);
  assert.ok(md.includes('実測ではない'), 'Markdown に断りが無い');
  assert.ok(html.includes('実測ではない'), 'HTML に断りが無い');
  assert.ok(md.includes('calibrate'));
  assert.ok(html.includes('calibrate'));
});

test('HTML は 1 ファイルで完結する', () => {
  const html = renderHtml(sweep({ nValues: [1, 4, 16], trials: 4 }));
  assert.ok(!/<script[^>]+\bsrc=/.test(html));
  assert.ok(!/<link[^>]+stylesheet/.test(html));
  assert.ok(html.includes('<svg'), 'グラフが入っている');
  assert.ok(!html.includes('NaN'), 'NaN が描画されていない');
  assert.ok(!html.includes('undefined'));
});

function mean(n, f) {
  let s = 0;
  for (let i = 1; i <= n; i++) s += f(i);
  return s / n;
}
