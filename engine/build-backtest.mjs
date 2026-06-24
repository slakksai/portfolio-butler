// 回测数据引擎: 跑 v3 完整动态回测 → 写 data/backtest.json (净值曲线/回撤/逐年/危机/全指标)
// 四条线: v3上沿(真动量引擎,survivorship高估上限,已扣5bp) / v3下沿(MTUM真实ETF) / 60-40+趋势 / 纯股SPY
// 诚实: 真相在上沿~下沿之间且偏下。本脚本只产数据, 不下结论。
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'data');

const UNIV = ('AAPL MSFT NVDA GOOGL AMZN META AVGO ORCL CRM ADBE AMD QCOM INTC CSCO TXN MU AMAT NOW TSLA HD MCD NKE SBUX COST WMT TGT LOW DIS NFLX UNH JNJ LLY ABBV MRK PFE TMO ABT DHR JPM BAC WFC GS MS V MA AXP BLK SPGI CAT BA HON GE UPS RTX LMT DE XOM CVX COP LIN PG KO PEP T VZ CMCSA LUMN').split(' ');
const SLE = ['SPY', 'MTUM', 'ASHR', 'FXI', 'IEF', 'GLD', 'DBC'];

function fetchY(sym, vol) {
  const j = JSON.parse(execFileSync('curl', ['-s', '-m', '50', '-A', 'Mozilla/5.0', `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=1262304000&period2=${Math.floor(Date.now() / 1000)}&interval=1d`], { encoding: 'utf8', maxBuffer: 128e6 }));
  const r = j.chart.result[0], ts = r.timestamp, q = r.indicators.quote[0], adj = r.indicators.adjclose ? r.indicators.adjclose[0].adjclose : q.close;
  const m = new Map();
  for (let i = 0; i < ts.length; i++) { const c = adj[i]; if (c > 0) m.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), vol ? { c, v: q.volume[i] || 0 } : c); }
  return m;
}

const U = {}, uok = []; for (const s of UNIV) { try { const m = fetchY(s, true); if (m.size > 300) { U[s] = m; uok.push(s); } } catch { } }
const S = {}; for (const s of SLE) S[s] = fetchY(s, false);
let ds = null; for (const s of uok) { const k = new Set(U[s].keys()); ds = ds ? new Set([...ds].filter(d => k.has(d))) : k; } for (const s of SLE) { const k = new Set(S[s].keys()); ds = new Set([...ds].filter(d => k.has(d))); }
const dates = [...ds].filter(d => d >= '2013-01-01').sort();
const ua = {}; for (const s of uok) ua[s] = dates.map(d => U[s].get(d));
const sa = {}; for (const s of SLE) sa[s] = dates.map(d => S[s].get(d));

// 动量引擎(日equity)
const mom = (s, i) => { const a = ua[s]; return (i >= 252 && a[i - 252].c > 0) ? a[i].c / a[i - 252].c - 1 : null; };
const volr = (s, i) => { const a = ua[s]; if (i < 252) return null; let x = 0, y = 0; for (let k = i - 59; k <= i; k++) x += a[k].v; for (let k = i - 251; k <= i; k++) y += a[k].v; return y > 0 ? (x / 60) / (y / 252) : null; };
const pick = i => { const c = uok.map(s => ({ s, m: mom(s, i), vr: volr(s, i) })).filter(x => x.m != null && x.vr != null); c.sort((a, b) => b.m - a.m); const t = c.slice(0, 20); t.sort((a, b) => b.vr - a.vr); return t.slice(0, 10).map(x => x.s); };
const START = 252; const eng = new Array(dates.length);
{ let e = 1, h = pick(START); eng[START] = 1; for (let i = START + 1; i < dates.length; i++) { let r = 0; for (const s of h) r += (ua[s][i].c / ua[s][i - 1].c - 1) / h.length; e *= 1 + r; eng[i] = e; if ((i - START) % 10 === 0) { const nh = pick(i); const ent = nh.filter(s => !h.includes(s)); e *= 1 - ent.length / 10 * 2 * 0.0005; h = nh; } } for (let i = 0; i < START; i++) eng[i] = 1; }

// 趋势sleeve(200日均线 long-flat)
const TA = ['SPY', 'IEF', 'GLD', 'DBC']; const trend = new Array(dates.length);
{ const ma = {}; for (const s of TA) { ma[s] = new Array(dates.length); for (let i = 0; i < dates.length; i++) { if (i < 200) { ma[s][i] = null; continue; } let sum = 0; for (let k = i - 199; k <= i; k++) sum += sa[s][k]; ma[s][i] = sum / 200; } } let t = 1; for (let i = 0; i <= START; i++) trend[i] = 1; for (let i = START + 1; i < dates.length; i++) { let r = 0; for (const s of TA) { const sig = ma[s][i - 1] != null && sa[s][i - 1] > ma[s][i - 1] ? 1 : 0; r += sig * (sa[s][i] / sa[s][i - 1] - 1) / TA.length; } t *= 1 + r; trend[i] = t; } }

// 组合模拟(季度再平衡, 5pp带/动量封顶25/年度强制, 双边10bp成本)
const W = { SPY: .30, MOM: .20, TREND: .15, IEF: .22, GLD: .05, ASHR: .025, FXI: .025, CASH: .03 };
function price(useEng) { return { SPY: sa.SPY, MOM: useEng ? eng : sa.MTUM, TREND: trend, IEF: sa.IEF, GLD: sa.GLD, ASHR: sa.ASHR, FXI: sa.FXI }; }
function sim(useEng) {
  const P = price(useEng), tks = Object.keys(W).filter(t => t !== 'CASH'); let tot = 1e6; const v = {}; for (const t of tks) v[t] = W[t] * 1e6; let cash = W.CASH * 1e6;
  const eq = new Array(dates.length); eq[START] = 1e6; let lm = dates[START].slice(0, 7), lq = Math.floor((+dates[START].slice(5, 7) - 1) / 3);
  for (let i = START + 1; i < dates.length; i++) {
    for (const t of tks) v[t] *= P[t][i] / P[t][i - 1]; tot = cash + Object.values(v).reduce((a, b) => a + b, 0);
    if (dates[i].slice(0, 7) !== lm) { lm = dates[i].slice(0, 7); const q = Math.floor((+dates[i].slice(5, 7) - 1) / 3); if (q !== lq) { lq = q; const yr = dates[i].slice(5, 7) === '01'; let dr = 0; for (const t of [...tks, 'CASH']) { const d = Math.abs((t === 'CASH' ? cash : v[t]) / tot - W[t]); if (d > dr) dr = d; } const cap = v.MOM / tot > 0.25; if (yr || dr > 0.05 || cap) { let turn = 0; for (const t of tks) turn += Math.abs(W[t] * tot - v[t]); turn += Math.abs(W.CASH * tot - cash); tot -= turn / 2 * 0.001; for (const t of tks) v[t] = W[t] * tot; cash = W.CASH * tot; } } }
    eq[i] = tot;
  }
  return eq;
}
function benchSPY() { const eq = new Array(dates.length); eq[START] = 1e6; for (let i = START + 1; i < dates.length; i++) eq[i] = eq[i - 1] * (sa.SPY[i] / sa.SPY[i - 1]); return eq; }
function bench6040() { const eq = new Array(dates.length); eq[START] = 1e6; let a = .5e6, b = .3e6, c = .2e6, lq = -1; for (let i = START + 1; i < dates.length; i++) { a *= sa.SPY[i] / sa.SPY[i - 1]; b *= sa.IEF[i] / sa.IEF[i - 1]; c *= trend[i] / trend[i - 1]; let t = a + b + c; const q = Math.floor((+dates[i].slice(5, 7) - 1) / 3); if (q !== lq) { lq = q; a = .5 * t; b = .3 * t; c = .2 * t; } eq[i] = a + b + c; } return eq; }

const EQ = { v3_high: sim(true), v3_low: sim(false), b6040: bench6040(), spy: benchSPY() };
const KEYS = ['v3_high', 'v3_low', 'b6040', 'spy'];
const LABEL = { v3_high: 'v3 上沿 · 真动量引擎', v3_low: 'v3 下沿 · MTUM 代理', b6040: '60/40 + 趋势', spy: '纯股 SPY' };

const years = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[START])) / (365.25 * 864e5);
function metrics(eq) {
  const r = [], yv = {};
  for (let i = START + 1; i < dates.length; i++) { const x = eq[i] / eq[i - 1] - 1; r.push(x); const y = dates[i].slice(0, 4); (yv[y] = yv[y] || []).push(x); }
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length, sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  const ppy = r.length / years;
  const cagr = Math.pow(eq[dates.length - 1] / eq[START], 1 / years) - 1, vol = sd(r) * Math.sqrt(ppy);
  const dn = r.filter(x => x < 0), dd = Math.sqrt(mean(dn.map(x => x * x))) * Math.sqrt(ppy);
  let pk = -1e9, mdd = 0; for (let i = START; i < dates.length; i++) { if (eq[i] > pk) pk = eq[i]; mdd = Math.min(mdd, eq[i] / pk - 1); }
  const yr = {}; for (const y in yv) yr[y] = yv[y].reduce((s, x) => s * (1 + x), 1) - 1;
  const yvals = Object.values(yr); const posYears = yvals.filter(x => x > 0).length;
  return {
    cagr, vol, sharpe: (cagr - .02) / vol, sortino: (cagr - .02) / dd, mdd, calmar: cagr / -mdd,
    totalReturn: eq[dates.length - 1] / eq[START] - 1, final: eq[dates.length - 1],
    bestYear: Math.max(...yvals), worstYear: Math.min(...yvals), posYearsPct: posYears / yvals.length, yr
  };
}
const M = {}; for (const k of KEYS) M[k] = metrics(EQ[k]);

// 月度归一化净值曲线(start=100) + 回撤序列
const monthIdx = []; { let lm = ''; for (let i = START; i < dates.length; i++) { const m = dates[i].slice(0, 7); if (m !== lm) { lm = m; monthIdx.push(i); } } if (monthIdx[monthIdx.length - 1] !== dates.length - 1) monthIdx.push(dates.length - 1); }
const peak = {}; for (const k of KEYS) peak[k] = -1e9;
const series = monthIdx.map(i => { const row = { date: dates[i] }; for (const k of KEYS) { const nv = EQ[k][i] / EQ[k][START] * 100; row[k] = +nv.toFixed(2); peak[k] = Math.max(peak[k], EQ[k][i]); row['dd_' + k] = +((EQ[k][i] / peak[k] - 1) * 100).toFixed(2); } return row; });

// 逐年表
const allYears = Object.keys(M.spy.yr).sort();
const yearly = allYears.map(y => { const row = { year: y }; for (const k of KEYS) row[k] = M[k].yr[y] != null ? +(M[k].yr[y] * 100).toFixed(1) : null; return row; });

// 危机窗口(美股, 用日eq算窗口收益)
const idxOf = d => { let lo = 0; for (let i = START; i < dates.length; i++) { if (dates[i] >= d) { lo = i; break; } lo = i; } return lo; };
const CRISES = [
  { name: '2015 人民币贬值/8月闪崩', start: '2015-08-17', end: '2015-09-29' },
  { name: '2018Q4 加息恐慌', start: '2018-09-20', end: '2018-12-24' },
  { name: '2020 新冠崩盘', start: '2020-02-19', end: '2020-03-23' },
  { name: '2022 通胀加息熊市', start: '2022-01-03', end: '2022-10-12' },
];
const crises = CRISES.map(c => { const a = idxOf(c.start), b = idxOf(c.end); const row = { name: c.name, start: dates[a], end: dates[b] }; for (const k of KEYS) row[k] = +((EQ[k][b] / EQ[k][a] - 1) * 100).toFixed(1); return row; }).filter(c => c.start < c.end);

const out = {
  asOf: dates[dates.length - 1], generatedAt: new Date().toISOString(),
  window: { start: dates[START], end: dates[dates.length - 1], years: +years.toFixed(1) },
  config: '美股30 · 动量20(顶25) · 趋势15 · 国债22 · 黄金5 · 中国5(A2.5+港2.5) · 现金3',
  rebalance: '季度检视; 任一板块偏离>5pp 或 动量>25% 或 年初 → 调回目标; 双边成本10bp',
  riskFree: 0.02, universeCount: uok.length,
  labels: LABEL, keys: KEYS,
  metrics: M, series, yearly, crises,
  notes: '上沿=真动量引擎(survivorship高估上限,已扣5bp换手成本); 下沿=MTUM真实动量ETF(无幸存者偏差); 趋势=200日均线long-flat代理(低估真CTA的危机alpha); 真相在上沿~下沿之间且偏下。SPY/60-40为对照基准。无风险利率2%。'
};
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'backtest.json'), JSON.stringify(out, null, 2));
const pp = x => (x * 100).toFixed(1) + '%';
console.log(`wrote data/backtest.json | ${out.window.start}~${out.window.end} (${out.window.years}y) | 宇宙${uok.length}`);
for (const k of KEYS) console.log(`  ${LABEL[k].padEnd(20)} CAGR ${pp(M[k].cagr).padStart(7)} Sharpe ${M[k].sharpe.toFixed(2)} MaxDD ${pp(M[k].mdd).padStart(7)} 期末$${Math.round(M[k].final).toLocaleString()}`);
