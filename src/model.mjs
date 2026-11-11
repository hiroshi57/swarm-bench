/**
 * 掲示板型 swarm の離散ラウンド・シミュレーション。
 *
 * ─────────────────────────────────────────────────────────────
 * これは「モデル」であって実測ではない。
 *
 * 実際の LLM を 100 体起動して測るのは高くつくうえ、1 回の結果はタスク依存で
 * ぶれる。そこで、台数を変えたときに**構造として**何が起きるかを先に見る。
 *
 * モデルのパラメータは実際の board.jsonl から calibrate() で推定できる。
 * 実測 → 較正 → 外挿、という順で使うこと。
 * モデル単体の数字を「100 体ならこうなる」と言い切ってはいけない。
 * ─────────────────────────────────────────────────────────────
 *
 * モデルに入れている 5 つの効き目:
 *
 * 1. Amdahl   … 直列にしか進まない部分は台数を増やしても縮まない
 * 2. 監督の帯域 … coordinator が 1 ラウンドに捌ける割当・回答には上限がある
 * 3. 検証の帯域 … verifier が 1 ラウンドに検証できる件数には上限がある
 * 4. 混線     … 台数が増えるほど確認や受け渡しが増え、1 件あたりの完了率が落ちる
 * 5. 掲示板の肥大 … 投稿が増えるほど全員のプロンプトが伸び、1 ターンの単価が上がる
 */

/** 決定論的な擬似乱数（同じ seed なら同じ結果になる） */
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULTS = {
  subtasks: 48,          // 仕事を割れる最小単位の数
  serialFraction: 0.08,  // どうしても直列になる割合（Amdahl の s）
  pComplete: 0.62,       // worker が 1 ラウンドで 1 件を仕上げる確率
  pDefect: 0.22,         // 仕上げた成果に欠陥が混ざる確率
  pCatch: 0.78,          // verifier が欠陥を見抜く確率
  verifierThroughput: 6, // verifier 1 体が 1 ラウンドに検証できる件数
  coordinatorCapacity: 12, // coordinator が 1 ラウンドに捌ける割当・回答の件数
  contention: 0.10,      // 台数倍化あたり完了率が落ちる割合
  defectAmplify: 0.06,   // 台数倍化あたり欠陥率が増える割合（文脈の共有不足）
  maxRounds: 120,
  boardWindow: 40,       // プロンプトに載せる直近投稿数の上限
  postTokens: 180,
  systemTokens: 1200,
  outputTokens: 700,
};

const log2 = (x) => Math.log2(Math.max(1, x));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * 1 回の走行をシミュレートする。
 * @param {object} o
 * @param {number} o.workers worker 数
 * @param {number} [o.verifiers] verifier 数
 * @param {number} [o.seed]
 * @returns {object} 1 走行の指標
 */
export function simulate({ workers, verifiers = 1, seed = 1, ...over } = {}) {
  const p = { ...DEFAULTS, ...over };
  if (!Number.isInteger(workers) || workers < 1) throw new RangeError('workers は 1 以上の整数が必要です');
  if (!Number.isInteger(verifiers) || verifiers < 1) throw new RangeError('verifiers は 1 以上の整数が必要です');

  const rand = rng(seed * 2654435761 + workers * 40503 + verifiers * 7919);

  // 台数が増えることの副作用
  const pComplete = clamp(p.pComplete * (1 - p.contention * log2(workers)), 0.05, 1);
  const pDefect = clamp(p.pDefect * (1 + p.defectAmplify * log2(workers)), 0, 0.95);

  const serialUnits = Math.max(1, Math.round(p.subtasks * p.serialFraction));
  const parallelUnits = p.subtasks - serialUnits;

  let doneParallel = 0;       // 完了した並列タスク（検証待ちを含む）
  let doneSerial = 0;
  let inVerifyQueue = [];     // {defective:boolean}
  let shippedOk = 0;
  let shippedDefective = 0;   // 見逃された欠陥
  let reworks = 0;
  let caught = 0;
  let verified = 0;
  let posts = 1;              // 最初の note
  let round = 0;
  let inTok = 0, outTok = 0;
  const turnsByRole = { coordinator: 0, worker: 0, verifier: 0 };
  const perRound = [];

  const promptTokens = () => p.systemTokens + Math.min(p.boardWindow, posts) * p.postTokens;

  while (round < p.maxRounds) {
    round++;
    const roundPosts = [];
    const pt = promptTokens();

    // --- coordinator: 1 ラウンドに捌ける件数に上限がある ---
    const wantAssign = Math.min(workers, parallelUnits - doneParallel) + (doneSerial < serialUnits ? 1 : 0);
    const assignable = Math.min(wantAssign, p.coordinatorCapacity);
    if (assignable > 0 || inVerifyQueue.length > 0) {
      turnsByRole.coordinator++;
      inTok += pt; outTok += p.outputTokens;
      roundPosts.push(assignable);
    }

    // --- worker: 並列ぶん ---
    const activeWorkers = Math.min(workers, assignable, Math.max(0, parallelUnits - doneParallel));
    for (let i = 0; i < activeWorkers; i++) {
      turnsByRole.worker++;
      inTok += pt; outTok += p.outputTokens;
      if (rand() < pComplete) {
        doneParallel++;
        inVerifyQueue.push({ defective: rand() < pDefect });
        roundPosts.push(1);
      }
    }

    // --- 直列ぶんは 1 ラウンドに 1 件しか進まない（台数と無関係） ---
    if (doneSerial < serialUnits && activeWorkers >= 0) {
      turnsByRole.worker++;
      inTok += pt; outTok += p.outputTokens;
      if (rand() < p.pComplete) {
        doneSerial++;
        inVerifyQueue.push({ defective: rand() < pDefect });
        roundPosts.push(1);
      }
    }

    // --- verifier: 帯域ぶんだけ処理する ---
    const capacity = verifiers * p.verifierThroughput;
    const batch = inVerifyQueue.splice(0, capacity);
    if (batch.length > 0) {
      const turns = Math.min(verifiers, Math.ceil(batch.length / p.verifierThroughput));
      turnsByRole.verifier += turns;
      inTok += pt * turns; outTok += p.outputTokens * turns;
      for (const item of batch) {
        verified++;
        roundPosts.push(1);
        if (item.defective) {
          if (rand() < p.pCatch) {
            caught++; reworks++;
            // 差し戻し。もう一度作り直して検証列に戻る
            inVerifyQueue.push({ defective: rand() < pDefect * 0.5 });
          } else {
            shippedDefective++;
          }
        } else {
          shippedOk++;
        }
      }
    }

    posts += roundPosts.reduce((a, b) => a + b, 0);
    perRound.push({ round, posts, inVerifyQueue: inVerifyQueue.length, shipped: shippedOk + shippedDefective });

    if (doneParallel >= parallelUnits && doneSerial >= serialUnits && inVerifyQueue.length === 0) break;
  }

  const shipped = shippedOk + shippedDefective;
  const quality = shipped > 0 ? shippedOk / shipped : 0;
  const completion = shipped / p.subtasks;

  return {
    workers, verifiers, seed,
    rounds: round,
    finished: doneParallel >= parallelUnits && doneSerial >= serialUnits && inVerifyQueue.length === 0,
    subtasks: p.subtasks,
    shipped,
    completion: r4(completion),
    quality: r4(quality),                       // 出荷物のうち欠陥でない割合
    goodput: r4(shippedOk / p.subtasks),        // 全体として正しく仕上がった割合
    escapedDefects: shippedDefective,
    reworks,
    catchRate: verified > 0 ? r4(caught / Math.max(1, caught + shippedDefective)) : 0,
    turns: turnsByRole.coordinator + turnsByRole.worker + turnsByRole.verifier,
    turnsByRole,
    posts,
    input_tokens: inTok,
    output_tokens: outTok,
    perRound,
    effective: { pComplete: r4(pComplete), pDefect: r4(pDefect) },
  };
}

/**
 * 実際の board.jsonl からモデルのパラメータを推定する。
 * モデルを信じる前に、必ず自分のボードで較正すること。
 *
 * @param {string[]} boardTexts board.jsonl の中身の配列
 */
export function calibrate(boardTexts) {
  const posts = [];
  for (const text of boardTexts) {
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try { const o = JSON.parse(t); if (o && typeof o === 'object') posts.push(o); } catch { /* 壊れた行は無視 */ }
    }
  }
  if (posts.length === 0) return { ok: false, reason: '読めた投稿がありません', samples: 0 };

  const roleOf = (n) => {
    if (typeof n !== 'string' || !n.startsWith('@')) return 'unknown';
    const s = n.slice(1).toLowerCase();
    if (s.startsWith('coordinator')) return 'coordinator';
    if (s.startsWith('verifier')) return 'verifier';
    if (s.startsWith('worker')) return 'worker';
    if (s === 'human') return 'human';
    return 'unknown';
  };

  const verdicts = { pass: 0, needs_changes: 0, fail: 0 };
  let dones = 0, assigns = 0, answers = 0;
  const rounds = new Set();
  const verifierTurns = new Map();
  const coordinatorPerRound = new Map();
  const doneByTask = new Map();
  const verifierNames = new Set();

  for (const p of posts) {
    const r = p.meta?.round;
    if (Number.isFinite(r)) rounds.add(r);
    const role = roleOf(p.from);
    if (role === 'verifier') verifierNames.add(p.from);
    if (p.type === 'verify_result' && p.verdict in verdicts) {
      verdicts[p.verdict]++;
      if (Number.isFinite(r)) verifierTurns.set(`${p.from}:${r}`, (verifierTurns.get(`${p.from}:${r}`) ?? 0) + 1);
    }
    if (p.type === 'done' && role === 'worker') {
      dones++;
      if (p.task_id) doneByTask.set(p.task_id, (doneByTask.get(p.task_id) ?? 0) + 1);
    }
    if (p.type === 'assign') { assigns++; if (Number.isFinite(r)) bump(coordinatorPerRound, r); }
    if (p.type === 'answer') { answers++; if (Number.isFinite(r)) bump(coordinatorPerRound, r); }
  }

  const vTotal = verdicts.pass + verdicts.needs_changes + verdicts.fail;
  const rejected = verdicts.needs_changes + verdicts.fail;
  const tasks = [...doneByTask.values()];
  const reworkRate = tasks.length ? (tasks.reduce((s, n) => s + (n - 1), 0) / tasks.length) : 0;

  // 観測できるのは「verifier が弾いた率」。見逃しは定義上ボードに現れないので、
  // pDefect は「少なくともこれ以上」という下限として扱う。
  const observedRejectRate = vTotal ? rejected / vTotal : null;

  const vThroughput = verifierTurns.size ? mean([...verifierTurns.values()]) : null;
  const cCapacity = coordinatorPerRound.size ? mean([...coordinatorPerRound.values()]) : null;

  return {
    ok: true,
    samples: posts.length,
    boards: boardTexts.length,
    rounds: rounds.size || null,
    observed: { verdicts, dones, assigns, answers, verifiers: verifierNames.size },
    suggested: {
      ...(observedRejectRate !== null ? { pDefect: r4(observedRejectRate) } : {}),
      ...(vThroughput !== null ? { verifierThroughput: Math.max(1, Math.round(vThroughput)) } : {}),
      ...(cCapacity !== null ? { coordinatorCapacity: Math.max(1, Math.round(cCapacity)) } : {}),
    },
    notes: [
      observedRejectRate === null
        ? 'verify_result が 1 件も無いため pDefect を推定できません'
        : `差し戻し率 ${(observedRejectRate * 100).toFixed(1)}% を pDefect の下限として使います（見逃した欠陥はボードに現れないため）`,
      reworkRate > 0 ? `1 タスクあたり平均 ${r4(reworkRate)} 回の作り直しが発生しています` : '作り直しは観測されていません',
      rounds.size === 0 ? 'meta.round が無いため帯域を推定できません（swarm-board-core v0.1 以降で記録されます）' : null,
      vTotal < 20 ? `検証サンプルが ${vTotal} 件しかありません。較正には 50 件以上を推奨します` : null,
    ].filter(Boolean),
  };
}

function bump(m, k) { m.set(k, (m.get(k) ?? 0) + 1); }
function mean(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
function r4(n) { return Math.round(n * 10000) / 10000; }

export { r4 };
