import { simulate, r4 } from './model.mjs';
import { costOf } from 'swarm-cost-governor';

/**
 * 台数を振って、品質・コスト・時間がどう変わるかを集める。
 *
 * 1 点につき trials 回走らせて平均と 95% 信頼区間を出す。
 * 1 回の結果だけを見て「10 体が最適」と言うのは、ばらつきを無視している。
 */
export function sweep({
  nValues = [1, 2, 4, 8, 16, 32, 64, 100],
  verifiers = 1,
  trials = 20,
  models = { coordinator: 'claude-opus-5', worker: 'claude-sonnet-5', verifier: 'claude-opus-5' },
  seed0 = 1,
  ...params
} = {}) {
  if (!Array.isArray(nValues) || nValues.length === 0) throw new RangeError('nValues が空です');
  if (!Number.isInteger(trials) || trials < 1) throw new RangeError('trials は 1 以上の整数が必要です');

  const points = nValues.map((workers) => {
    const runs = [];
    for (let t = 0; t < trials; t++) {
      const r = simulate({ workers, verifiers, seed: seed0 + t, ...params });
      runs.push({ ...r, usd: runCost(r, models, verifiers) });
    }
    return summarizePoint(workers, verifiers, runs);
  });

  return { points, trials, verifiers, models, baseline: points[0], ...analyze(points) };
}

/** 役割ごとのモデルで課金額を出す */
function runCost(r, models, verifiers) {
  const total = r.turnsByRole.coordinator + r.turnsByRole.worker + r.turnsByRole.verifier || 1;
  let usd = 0;
  for (const [role, turns] of Object.entries(r.turnsByRole)) {
    const share = turns / total;
    usd += costOf({
      model: models[role] ?? 'claude-sonnet-5',
      input_tokens: r.input_tokens * share,
      output_tokens: r.output_tokens * share,
    });
  }
  return usd;
}

function summarizePoint(workers, verifiers, runs) {
  const agg = (key) => stats(runs.map((r) => r[key]));
  const q = agg('quality'), g = agg('goodput'), rd = agg('rounds'), c = agg('usd');
  return {
    workers, verifiers, trials: runs.length,
    quality: q, goodput: g, rounds: rd, usd: c,
    reworks: agg('reworks').mean,
    escapedDefects: agg('escapedDefects').mean,
    turns: agg('turns').mean,
    posts: agg('posts').mean,
    finishedRate: r4(runs.filter((r) => r.finished).length / runs.length),
    usdPerGood: g.mean > 0 ? r4(c.mean / (g.mean * runs[0].subtasks)) : null,
    effective: runs[0].effective,
  };
}

function stats(xs) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const ci = n > 1 ? 1.96 * (sd / Math.sqrt(n)) : 0;
  const sortedXs = xs.slice().sort((a, b) => a - b);
  return {
    mean: r4(mean), sd: r4(sd), ci95: r4(ci),
    lo: r4(mean - ci), hi: r4(mean + ci),
    min: r4(sortedXs[0]), max: r4(sortedXs[n - 1]),
  };
}

/** 掃引の結果から「で、何体がいいのか」を読み取る */
function analyze(points) {
  const base = points[0];
  const withDerived = points.map((p) => ({
    ...p,
    speedup: r4(base.rounds.mean / p.rounds.mean),
    costMultiple: r4(p.usd.mean / Math.max(1e-9, base.usd.mean)),
    qualityDelta: r4(p.quality.mean - base.quality.mean),
  }));

  // 最良点: 正味の成果 / コスト が最大になる台数
  const bestValue = withDerived.reduce((a, b) => (b.goodput.mean / Math.max(1e-9, b.usd.mean) > a.goodput.mean / Math.max(1e-9, a.usd.mean) ? b : a));
  const bestSpeed = withDerived.reduce((a, b) => (b.rounds.mean < a.rounds.mean ? b : a));
  const bestQuality = withDerived.reduce((a, b) => (b.quality.mean > a.quality.mean ? b : a));

  // 飽和点: ここから先は台数を倍にしても所要が 10% も縮まない
  let saturation = withDerived.at(-1).workers;
  for (let i = 1; i < withDerived.length; i++) {
    const prev = withDerived[i - 1], cur = withDerived[i];
    if ((prev.rounds.mean - cur.rounds.mean) / prev.rounds.mean < 0.10) { saturation = prev.workers; break; }
  }

  // 品質が有意に落ち始める台数（信頼区間が重ならない最初の点）
  const qualityBreaks = withDerived.find((p) => p.quality.hi < base.quality.lo);

  return {
    points: withDerived,
    verdict: {
      bestValueWorkers: bestValue.workers,
      bestSpeedWorkers: bestSpeed.workers,
      bestQualityWorkers: bestQuality.workers,
      saturationWorkers: saturation,
      qualityBreaksAt: qualityBreaks ? qualityBreaks.workers : null,
      maxSpeedup: r4(base.rounds.mean / bestSpeed.rounds.mean),
      costAtMaxSpeed: r4(bestSpeed.usd.mean / Math.max(1e-9, base.usd.mean)),
    },
    findings: findings(withDerived, base, saturation, qualityBreaks, bestValue),
  };
}

function findings(points, base, saturation, qualityBreaks, bestValue) {
  const out = [];
  const last = points.at(-1);

  out.push({
    level: 'key',
    text: `所要ラウンドは ${saturation} 体あたりで飽和する。`
      + `${base.workers} 体 ${base.rounds.mean} ラウンド → ${last.workers} 体 ${last.rounds.mean} ラウンド（${r4(base.rounds.mean / last.rounds.mean)} 倍速）`,
    why: '直列部分と、監督・検証の帯域が上限になるため。台数を増やしても待ち行列が伸びるだけになる',
  });

  if (qualityBreaks) {
    out.push({
      level: 'warn',
      text: `${qualityBreaks.workers} 体を超えると品質が有意に下がる（${base.quality.mean} → ${qualityBreaks.quality.mean}、信頼区間が重ならない）`,
      why: '台数が増えるほど文脈の共有が薄れて欠陥が増え、同時に verifier が捌ききれず見逃しが出る',
    });
  } else {
    out.push({ level: 'ok', text: '測った範囲では、台数を増やしても品質の有意な低下は出なかった', why: 'verifier の帯域が足りている' });
  }

  out.push({
    level: 'key',
    text: `費用対効果が最も良いのは ${bestValue.workers} 体（正味成果 / コスト が最大）`,
    why: 'ここより少ないと遅く、多いと掲示板の肥大と待ち行列でコストだけが増える',
  });

  const costRatio = last.usd.mean / Math.max(1e-9, base.usd.mean);
  const speedRatio = base.rounds.mean / last.rounds.mean;
  if (costRatio > speedRatio * 2) {
    out.push({
      level: 'warn',
      text: `${last.workers} 体はコストが ${r4(costRatio)} 倍になるのに、速さは ${r4(speedRatio)} 倍にしかならない`,
      why: '掲示板が伸びて全員のプロンプトが長くなるため。boardWindow を絞らない限りこの差は開く',
    });
  }

  const escaped = last.escapedDefects;
  if (escaped > base.escapedDefects * 1.5) {
    out.push({
      level: 'warn',
      text: `見逃した欠陥が ${base.escapedDefects} 件 → ${escaped} 件に増える`,
      why: 'verifier を増やさずに worker だけ増やすと、検証が追いつかない',
    });
  }
  return out;
}

/** verifier の数を変えて、検証帯域がボトルネックかを確かめる */
export function verifierSweep({ workers = 32, verifierValues = [1, 2, 4, 8], trials = 20, ...rest } = {}) {
  return verifierValues.map((verifiers) => {
    const s = sweep({ nValues: [workers], verifiers, trials, ...rest });
    return { verifiers, ...s.points[0] };
  });
}

export { stats };
