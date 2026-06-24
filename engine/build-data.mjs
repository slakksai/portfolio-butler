// 投资管家·云端数据引擎
// 抓实时行情(Yahoo, 免钥) → 算动量选股/断路器/目标配置 → 写 data/latest.json
// 本地: node engine/build-data.mjs   |  云端: GitHub Actions 定时跑(见 .github/workflows/refresh.yml)
// 零本地数据依赖, 只需 node + curl + 联网。curl 在 Windows/Ubuntu 皆可用, 且绕开本地代理坑。
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'data');
const OUT = join(OUT_DIR, 'latest.json');

// 动量宇宙: 66 只代表性大盘(有 survivorship 上沿偏差; 真部署应接全标普500+精确规则)
const UNIV = ('AAPL MSFT NVDA GOOGL AMZN META AVGO ORCL CRM ADBE AMD QCOM INTC CSCO TXN MU AMAT NOW TSLA HD MCD NKE SBUX COST WMT TGT LOW DIS NFLX UNH JNJ LLY ABBV MRK PFE TMO ABT DHR JPM BAC WFC GS MS V MA AXP BLK SPGI CAT BA HON GE UPS RTX LMT DE XOM CVX COP LIN PG KO PEP T VZ CMCSA').split(' ');
const SLE = ['SPY', 'DBMF', 'IEF', 'GLD', 'ASHR', 'FXI']; // 被动板块 ETF

function fetchY(sym, vol) {
  const j = JSON.parse(execFileSync('curl', ['-s', '-m', '40', '-A', 'Mozilla/5.0',
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=1262304000&period2=${Math.floor(Date.now() / 1000)}&interval=1d`],
    { encoding: 'utf8', maxBuffer: 128e6 }));
  const r = j.chart.result[0], ts = r.timestamp, q = r.indicators.quote[0];
  const adj = r.indicators.adjclose ? r.indicators.adjclose[0].adjclose : q.close;
  const m = new Map();
  for (let i = 0; i < ts.length; i++) {
    const c = adj[i];
    if (c > 0) m.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), vol ? { c, v: q.volume[i] || 0, raw: q.close[i] } : { c, raw: q.close[i] });
  }
  return m;
}

// 抓取
const U = {}, uok = [];
for (const s of UNIV) { try { const m = fetchY(s, true); if (m.size > 300) { U[s] = m; uok.push(s); } } catch { } }
const S = {}; for (const s of SLE) { try { S[s] = fetchY(s, false); } catch { throw new Error(`板块 ETF ${s} 抓取失败, 中止`); } }
if (uok.length < 30) throw new Error(`动量宇宙仅抓到 ${uok.length} 只(<30), 数据不足, 中止`);

// 交易日对齐(取交集)
let ds = null;
for (const s of uok) { const k = new Set(U[s].keys()); ds = ds ? new Set([...ds].filter(d => k.has(d))) : k; }
for (const s of SLE) { const k = new Set(S[s].keys()); ds = new Set([...ds].filter(d => k.has(d))); }
const dates = [...ds].sort(); const N = dates.length, i = N - 1, today = dates[i];
const ua = {}; for (const s of uok) ua[s] = dates.map(d => U[s].get(d));
const sa = {}; for (const s of SLE) sa[s] = dates.map(d => S[s].get(d));

// 动量选股(今日): 252日动量取前20, 再按近60/252日量比取前10
const mom = (s, j) => { const a = ua[s]; return (j >= 252 && a[j - 252].c > 0) ? a[j].c / a[j - 252].c - 1 : null; };
const volr = (s, j) => { const a = ua[s]; if (j < 252) return null; let x = 0, y = 0; for (let k = j - 59; k <= j; k++) x += a[k].v; for (let k = j - 251; k <= j; k++) y += a[k].v; return y > 0 ? (x / 60) / (y / 252) : null; };
const cand = uok.map(s => ({ s, m: mom(s, i), vr: volr(s, i) })).filter(x => x.m != null && x.vr != null);
cand.sort((a, b) => b.m - a.m); const top20 = cand.slice(0, 20); top20.sort((a, b) => b.vr - a.vr);
const momPicks = top20.slice(0, 10);

// 断路器: 动量引擎近3年累计收益 vs SPY (每10交易日重排, 等权)
function engRet(span) {
  let e = 1, h = null;
  for (let j = i - span; j < i; j++) {
    if ((j - (i - span)) % 10 === 0 || !h) {
      const c = uok.map(s => ({ s, m: mom(s, j), vr: volr(s, j) })).filter(x => x.m != null && x.vr != null);
      c.sort((a, b) => b.m - a.m); const t = c.slice(0, 20); t.sort((a, b) => b.vr - a.vr); h = t.slice(0, 10).map(x => x.s);
    }
    let r = 0; for (const s of h) r += (ua[s][j + 1].c / ua[s][j].c - 1) / h.length; e *= 1 + r;
  }
  return e - 1;
}
const m3 = engRet(756), s3 = sa.SPY[i].c / sa.SPY[i - 756].c - 1, ex = m3 - s3;
const momW = ex > -0.10 ? 0.20 : ex > -0.25 ? 0.10 : 0.0;
const toSPY = 0.20 - momW;
const cbStatus = momW === 0.20 ? '正常满仓' : momW === 0.10 ? '半仓警告(释放10%→SPY)' : '熔断(动量0%, 全部→SPY)';

// 市场风险背景(数据驱动, 非新闻): SPY vs 200日均线; 距一年高点回撤
let ma200 = 0; for (let k = i - 199; k <= i; k++) ma200 += sa.SPY[k].c; ma200 /= 200;
const spyAboveMA200 = sa.SPY[i].c > ma200;
let hi = 0; for (let k = i - 252; k <= i; k++) hi = Math.max(hi, sa.SPY[k].c); const ddFromHigh = sa.SPY[i].c / hi - 1;

// 板块目标权重(美股吸收断路器释放的权重)
const sleeves = [
  { key: '美股', etf: 'SPY', weight: 0.30 + toSPY, price: S.SPY.get(today).raw },
  { key: '动量', etf: '(你的10只)', weight: momW, isMomentum: true },
  { key: '趋势', etf: 'DBMF', weight: 0.15, price: S.DBMF.get(today).raw },
  { key: '国债', etf: 'IEF', weight: 0.22, price: S.IEF.get(today).raw },
  { key: '黄金', etf: 'GLD', weight: 0.05, price: S.GLD.get(today).raw },
  { key: 'A股', etf: 'ASHR', weight: 0.025, price: S.ASHR.get(today).raw },
  { key: '港股', etf: 'FXI', weight: 0.025, price: S.FXI.get(today).raw },
  { key: '现金', etf: '(货币基金)', weight: 0.03, isCash: true },
];

const out = {
  asOf: today,
  generatedAt: new Date().toISOString(),
  capitalBase: 1000000,
  universeCount: uok.length,
  risk: { spyAboveMA200, spyPrice: sa.SPY[i].raw, spyMA200Adj: +ma200.toFixed(2), ddFromHigh: +ddFromHigh.toFixed(4) },
  circuit: { mom3y: +m3.toFixed(4), spy3y: +s3.toFixed(4), excess: +ex.toFixed(4), momentumWeight: momW, status: cbStatus },
  momentum: momPicks.map(p => ({ ticker: p.s, price: +ua[p.s][i].raw.toFixed(2), mom: +p.m.toFixed(4), volRatio: +p.vr.toFixed(2) })),
  sleeves: sleeves.map(s => s.price != null ? { ...s, price: +s.price.toFixed(2) } : s),
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`wrote ${OUT}  asOf=${today}  universe=${uok.length}  momW=${momW}  excess=${(ex * 100).toFixed(0)}%`);
