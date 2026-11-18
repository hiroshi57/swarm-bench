import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calibrate } from '../src/model.mjs';
import { sweep } from '../src/bench.mjs';

const REAL = 'data/real-board-ollama-qwen7b.jsonl';

test('同梱の実ボードから監督の帯域を推定できる', () => {
  const c = calibrate([readFileSync(REAL, 'utf8')]);
  assert.equal(c.ok, true);
  assert.equal(c.suggested.coordinatorCapacity, 3);
  assert.equal(c.observed.assigns, 9);
  assert.equal(c.rounds, 6);
});

test('実ボードには done も verify_result も無い（7B は終端の型を出せなかった）', () => {
  const c = calibrate([readFileSync(REAL, 'utf8')]);
  assert.equal(c.observed.dones, 0);
  assert.equal(c.observed.verdicts.pass + c.observed.verdicts.needs_changes + c.observed.verdicts.fail, 0);
  assert.equal(c.suggested.pDefect, undefined, '観測できない値を埋めない');
  assert.ok(c.notes.some((n) => n.includes('推定できません')));
});

test('監督の帯域が狭いほど最適な台数は小さくなる', () => {
  const narrow = sweep({ nValues: [1, 4, 16, 64, 100], trials: 12, coordinatorCapacity: 3 });
  const wide = sweep({ nValues: [1, 4, 16, 64, 100], trials: 12, coordinatorCapacity: 12 });
  assert.ok(
    narrow.verdict.saturationWorkers < wide.verdict.saturationWorkers,
    `帯域3の飽和点 ${narrow.verdict.saturationWorkers} が帯域12の ${wide.verdict.saturationWorkers} を下回らない`,
  );
});

test('実測の帯域では 100 体が 1 体より速くならない', () => {
  const s = sweep({ nValues: [1, 100], trials: 12, coordinatorCapacity: 3 });
  const hundred = s.points.find((p) => p.workers === 100);
  assert.ok(hundred.speedup < 1.2, `100体の速度倍率 ${hundred.speedup} が想定より高い`);
  assert.ok(hundred.costMultiple > 1, '遅いうえに高い');
});
