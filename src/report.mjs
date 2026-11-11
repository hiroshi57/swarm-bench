const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderMarkdown(r) {
  const v = r.verdict;
  const rows = r.points.map((p) =>
    `| ${p.workers} | ${p.rounds.mean} ±${p.rounds.ci95} | ${p.speedup}x | ${p.quality.mean.toFixed(3)} ±${p.quality.ci95.toFixed(3)} | ${p.goodput.mean.toFixed(3)} | $${p.usd.mean.toFixed(2)} | ${p.costMultiple}x | ${p.escapedDefects.toFixed(1)} |`,
  ).join('\n');

  return `# 台数掃引の結果

各 ${r.trials} 試行 / verifier ${r.verifiers} 体。± は 95% 信頼区間。

> **これはモデルによる推計であって実測ではない。**
> \`swarm-bench calibrate <board.jsonl>\` で自分のボードに合わせてから読むこと。

| worker | ラウンド | 速度 | 品質 | 正味成果 | コスト | 倍率 | 見逃し |
|-------:|--------:|-----:|-----:|--------:|------:|-----:|------:|
${rows}

## 判定

| 観点 | 台数 |
|------|-----:|
| いちばん速い | ${v.bestSpeedWorkers} 体（${v.maxSpeedup} 倍速 / コスト ${v.costAtMaxSpeed} 倍） |
| いちばん品質が高い | ${v.bestQualityWorkers} 体 |
| 費用対効果が最良 | **${v.bestValueWorkers} 体** |
| 速度の飽和点 | ${v.saturationWorkers} 体 |
| 品質が崩れ始める点 | ${v.qualityBreaksAt ?? '測った範囲では見られない'} |

## 所見

${r.findings.map((f) => `- **${f.text}**\n  - なぜ: ${f.why}`).join('\n')}
`;
}

export function renderHtml(r) {
  const v = r.verdict;
  const pts = r.points;
  const maxRounds = Math.max(...pts.map((p) => p.rounds.hi));
  const maxUsd = Math.max(...pts.map((p) => p.usd.mean));

  const W = 820, H = 300, PAD = 48;
  const xs = pts.map((_, i) => PAD + (i / Math.max(1, pts.length - 1)) * (W - PAD * 2));
  const yRounds = pts.map((p) => H - PAD - (p.rounds.mean / maxRounds) * (H - PAD * 2));
  const yQual = pts.map((p) => H - PAD - p.quality.mean * (H - PAD * 2));
  const yCost = pts.map((p) => H - PAD - (p.usd.mean / maxUsd) * (H - PAD * 2));
  const path = (ys) => ys.map((y, i) => `${i ? 'L' : 'M'}${xs[i].toFixed(1)},${y.toFixed(1)}`).join(' ');

  const band = pts.map((p, i) => {
    const hi = H - PAD - (p.rounds.lo / maxRounds) * (H - PAD * 2);
    const lo = H - PAD - (p.rounds.hi / maxRounds) * (H - PAD * 2);
    return { x: xs[i], hi, lo };
  });
  const bandPath = band.map((b, i) => `${i ? 'L' : 'M'}${b.x.toFixed(1)},${b.lo.toFixed(1)}`).join(' ')
    + ' ' + band.slice().reverse().map((b) => `L${b.x.toFixed(1)},${b.hi.toFixed(1)}`).join(' ') + ' Z';

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>台数掃引: 1体 vs 10体 vs 100体</title><style>
:root{--bg:#0f1115;--panel:#161922;--line:#262b36;--fg:#e6e9ef;--dim:#8b93a7;--dim2:#5f6779;
--rounds:#38bdf8;--qual:#34d399;--cost:#f87171;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Hiragino Sans","Noto Sans JP",sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:28px 20px 70px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--dim2);margin:26px 0 10px}
.lede{color:var(--dim);margin:0 0 6px}
.caveat{background:#2a1f12;border:1px solid #5a4420;color:#fcd34d;border-radius:9px;padding:11px 14px;margin:14px 0 22px;font-size:13px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.kpi{background:var(--panel);padding:12px 15px}.kpi .k{font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--dim2)}
.kpi .v{font-size:22px;font-weight:600;font-family:var(--mono)}.kpi .n{font-size:11px;color:var(--dim)}
svg{background:var(--panel);border:1px solid var(--line);border-radius:10px;width:100%;height:auto}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--dim);margin-top:8px}
.legend span{display:flex;align-items:center;gap:6px}.sw{width:14px;height:3px;border-radius:2px}
table{width:100%;border-collapse:collapse;font-size:13px;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:7px 11px;border-bottom:1px solid var(--line);text-align:right}
th:first-child,td:first-child{text-align:left}
th{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim2);font-weight:600}
tr:last-child td{border-bottom:none}
.f{background:var(--panel);border:1px solid var(--line);border-left-width:3px;border-radius:9px;padding:11px 14px;margin-bottom:9px}
.f.key{border-left-color:#38bdf8}.f.warn{border-left-color:#fbbf24}.f.ok{border-left-color:#34d399}
.f b{display:block;margin-bottom:3px}.f span{color:var(--dim);font-size:12px}
code{font-family:var(--mono);font-size:12px;background:#12151c;border:1px solid var(--line);border-radius:4px;padding:1px 5px}
</style></head><body><div class="wrap">

<h1>台数掃引: 1体 vs 10体 vs 100体</h1>
<p class="lede">各 ${r.trials} 試行 / verifier ${r.verifiers} 体 / 帯は 95% 信頼区間</p>
<div class="caveat"><b>これはモデルによる推計であって実測ではない。</b><br>
実際の board.jsonl で <code>swarm-bench calibrate</code> を実行し、パラメータを自分の環境に合わせてから読むこと。
モデル単体の数字を「100 体ならこうなる」と外に出してはいけない。</div>

<div class="kpis">
  <div class="kpi"><div class="k">費用対効果が最良</div><div class="v">${v.bestValueWorkers} 体</div><div class="n">正味成果 / コスト</div></div>
  <div class="kpi"><div class="k">速度の飽和点</div><div class="v">${v.saturationWorkers} 体</div><div class="n">以降は倍にしても 10% 未満</div></div>
  <div class="kpi"><div class="k">最大速度</div><div class="v">${v.maxSpeedup}x</div><div class="n">コストは ${v.costAtMaxSpeed} 倍</div></div>
  <div class="kpi"><div class="k">品質が崩れる点</div><div class="v">${v.qualityBreaksAt ?? '—'}</div><div class="n">${v.qualityBreaksAt ? '体を超えると有意に低下' : '範囲内では見られない'}</div></div>
</div>

<h2>台数と指標の関係</h2>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="台数ごとのラウンド・品質・コスト">
  <path d="${bandPath}" fill="#38bdf822"/>
  <path d="${path(yRounds)}" fill="none" stroke="var(--rounds)" stroke-width="2"/>
  <path d="${path(yQual)}" fill="none" stroke="var(--qual)" stroke-width="2"/>
  <path d="${path(yCost)}" fill="none" stroke="var(--cost)" stroke-width="2" stroke-dasharray="5 3"/>
  ${pts.map((p, i) => `<circle cx="${xs[i].toFixed(1)}" cy="${yRounds[i].toFixed(1)}" r="3" fill="var(--rounds)"/>
  <text x="${xs[i].toFixed(1)}" y="${H - 16}" fill="#5f6779" font-size="11" text-anchor="middle" font-family="ui-monospace,monospace">${p.workers}</text>`).join('')}
  <text x="${PAD}" y="22" fill="#5f6779" font-size="11">各系列は自身の最大値で正規化</text>
</svg>
<div class="legend">
  <span><i class="sw" style="background:var(--rounds)"></i>所要ラウンド（少ないほど速い）</span>
  <span><i class="sw" style="background:var(--qual)"></i>品質（出荷物のうち欠陥でない割合）</span>
  <span><i class="sw" style="background:var(--cost)"></i>コスト</span>
</div>

<h2>数値</h2>
<table><tr><th>worker</th><th>ラウンド</th><th>速度</th><th>品質</th><th>正味成果</th><th>コスト</th><th>倍率</th><th>見逃し</th></tr>
${pts.map((p) => `<tr><td>${p.workers}</td><td>${p.rounds.mean} ±${p.rounds.ci95}</td><td>${p.speedup}x</td><td>${p.quality.mean.toFixed(3)}</td><td>${p.goodput.mean.toFixed(3)}</td><td>$${p.usd.mean.toFixed(2)}</td><td>${p.costMultiple}x</td><td>${p.escapedDefects.toFixed(1)}</td></tr>`).join('')}
</table>

<h2>所見</h2>
${r.findings.map((f) => `<div class="f ${esc(f.level)}"><b>${esc(f.text)}</b><span>なぜ: ${esc(f.why)}</span></div>`).join('')}

</div></body></html>`;
}
