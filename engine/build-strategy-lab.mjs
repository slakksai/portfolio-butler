// 策略实验室: 诚实改进三杠杆的回测(预注册参数,不调参凑结果)
//  ①真CTA(DBMF替long-flat趋势代理,仅短窗) ②波动目标(60d→年化10%,封顶1.0只减仓不加杠杆)
//  ③组合趋势开关(风险腿<200日均线→转现金,月度信号滞后1日)
// 动量腿一律MTUM下沿(避幸存者偏差); 成本双边10bp; 无风险2%. 含稳健性网格.
// 输出 data/strategy-lab.json. 只产数据不下结论(交给对抗验证).
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, '..', 'data');

const TK = ['SPY', 'MTUM', 'IEF', 'GLD', 'ASHR', 'FXI', 'DBC', 'DBMF'];
function fetchY(s) {
  const j = JSON.parse(execFileSync('curl', ['-s', '-m', '50', '-A', 'Mozilla/5.0', `https://query1.finance.yahoo.com/v8/finance/chart/${s}?period1=1262304000&period2=${Math.floor(Date.now() / 1000)}&interval=1d`], { encoding: 'utf8', maxBuffer: 128e6 }));
  const r = j.chart.result[0], ts = r.timestamp, q = r.indicators.quote[0], adj = r.indicators.adjclose ? r.indicators.adjclose[0].adjclose : q.close;
  const m = new Map(); for (let i = 0; i < ts.length; i++) { const c = adj[i]; if (c > 0) m.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), c); } return m;
}
const D = {}; for (const s of TK) D[s] = fetchY(s);

// 对齐(除DBMF外的交集; DBMF单独对齐用于短窗)
const core = ['SPY', 'MTUM', 'IEF', 'GLD', 'ASHR', 'FXI', 'DBC'];
let ds = null; for (const s of core) { const k = new Set(D[s].keys()); ds = ds ? new Set([...ds].filter(d => k.has(d))) : k; }
const datesAll = [...ds].filter(d => d >= '2013-01-01').sort();

// 200日均线(用各自价格), 60日实现波动
function ma(prices, n, i) { if (i < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += prices[k]; return s / n; }
function realVol(rets, i, n) { if (i < n) return null; let m = 0; for (let k = i - n + 1; k <= i; k++) m += rets[k]; m /= n; let v = 0; for (let k = i - n + 1; k <= i; k++) v += (rets[k] - m) ** 2; return Math.sqrt(v / n) * Math.sqrt(252); }

// 通用模拟: dates对齐, blocks={name:priceArr}, W权重, opts{trend,targetVol,maN,start}
// 风险腿(趋势开关作用): 美股/动量/黄金/A股/港股; 防御腿: 国债/趋势/现金 恒持
const RISK = new Set(['美股', '动量', '黄金', 'A股', '港股']);
function buildTrendProxy(dates, P) { // long-flat SPY/IEF/GLD/DBC, 200MA, 日度
  const A = ['SPY', 'IEF', 'GLD', 'DBC']; const eq = new Array(dates.length).fill(1); let t = 1;
  for (let i = 1; i < dates.length; i++) { let r = 0; for (const s of A) { const m = ma(P[s], 200, i - 1); const sig = m != null && P[s][i - 1] > m ? 1 : 0; r += sig * (P[s][i] / P[s][i - 1] - 1) / A.length; } t *= 1 + r; eq[i] = t; } return eq;
}
function sim(dates, blockPrice, W, opts) {
  const { trend = false, targetVol = null, maN = 200, start, cashYield = 0 } = opts;
  const names = Object.keys(W).filter(k => k !== '现金');
  // 各block日收益
  const ret = {}; for (const nm of names) { const p = blockPrice[nm]; ret[nm] = new Array(dates.length).fill(0); for (let i = 1; i < dates.length; i++) ret[nm][i] = p[i] / p[i - 1] - 1; }
  // 组合"满仓"日收益(base权重,无overlay) 用于vol估计
  const baseRet = new Array(dates.length).fill(0);
  for (let i = 1; i < dates.length; i++) { let r = 0; for (const nm of names) r += W[nm] * ret[nm][i]; baseRet[i] = r; }
  // 月度趋势信号(对风险腿): 用该腿价格 vs 自身200MA, 月初定、持有当月
  const sigHold = {}; for (const nm of names) sigHold[nm] = 1;
  let curMonth = '';
  // 模拟(美元持仓, 每日按目标有效权重再平衡, 成本10bp)
  let eq = 1e6; const hold = {}; for (const nm of names) hold[nm] = W[nm] * eq; let cash = (W['现金'] || 0) * eq;
  const equity = new Array(dates.length).fill(1e6); let cost10 = 0.001;
  for (let i = start + 1; i < dates.length; i++) {
    // 应用收益
    for (const nm of names) hold[nm] *= 1 + ret[nm][i]; cash *= 1 + cashYield / 252; // 现金按货基收益增长
    let tot = cash + names.reduce((a, nm) => a + hold[nm], 0); eq = tot;
    // 月初更新趋势信号
    const mo = dates[i].slice(0, 7);
    if (mo !== curMonth) { curMonth = mo; if (trend) for (const nm of names) { if (RISK.has(nm)) { const m = ma(blockPrice[nm], maN, i - 1); sigHold[nm] = (m != null && blockPrice[nm][i - 1] > m) ? 1 : 0; } else sigHold[nm] = 1; } }
    // vol缩放(日度,滞后, 封顶1.0)
    let scale = 1; if (targetVol) { const rv = realVol(baseRet, i - 1, 60); if (rv && rv > 0) scale = Math.min(1, targetVol / rv); }
    // 目标有效权重
    const effW = {}; let sumEff = 0; for (const nm of names) { const w = W[nm] * (trend ? sigHold[nm] : 1) * scale; effW[nm] = w; sumEff += w; }
    const cashW = Math.max(0, 1 - sumEff);
    // 再平衡到目标 + 成本
    let turnover = 0; for (const nm of names) turnover += Math.abs(effW[nm] * tot - hold[nm]); turnover += Math.abs(cashW * tot - cash);
    tot -= turnover / 2 * cost10; eq = tot;
    for (const nm of names) hold[nm] = effW[nm] * tot; cash = cashW * tot;
    equity[i] = eq;
  }
  return equity;
}

const years = (a, b) => (Date.parse(b) - Date.parse(a)) / (365.25 * 864e5);
function metrics(eq, dates, start) {
  const r = [], yv = {}; for (let i = start + 1; i < dates.length; i++) { const x = eq[i] / eq[i - 1] - 1; r.push(x); const y = dates[i].slice(0, 4); (yv[y] = yv[y] || []).push(x); }
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length, sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  const yr = years(dates[start], dates[dates.length - 1]), ppy = r.length / yr;
  const cagr = Math.pow(eq[dates.length - 1] / eq[start], 1 / yr) - 1, vol = sd(r) * Math.sqrt(ppy);
  const dn = r.filter(x => x < 0), dd = Math.sqrt(mean(dn.map(x => x * x))) * Math.sqrt(ppy);
  let pk = -1e9, mdd = 0; for (let i = start; i < dates.length; i++) { if (eq[i] > pk) pk = eq[i]; mdd = Math.min(mdd, eq[i] / pk - 1); }
  const yrr = {}; for (const y in yv) yrr[y] = yv[y].reduce((s, x) => s * (1 + x), 1) - 1;
  return { cagr: +cagr.toFixed(4), vol: +vol.toFixed(4), sharpe: +((cagr - .02) / vol).toFixed(3), sortino: +((cagr - .02) / dd).toFixed(3), mdd: +mdd.toFixed(4), calmar: +(cagr / -mdd).toFixed(3), totalReturn: +(eq[dates.length - 1] / eq[start] - 1).toFixed(3), yr: yrr };
}
const CRISES = [{ name: '2018Q4', s: '2018-09-20', e: '2018-12-24' }, { name: '2020新冠', s: '2020-02-19', e: '2020-03-23' }, { name: '2022熊市', s: '2022-01-03', e: '2022-10-12' }];
function crisisRet(eq, dates) { return CRISES.map(c => { let a = 0, b = 0; for (let i = 0; i < dates.length; i++) { if (dates[i] <= c.s) a = i; if (dates[i] <= c.e) b = i; } return a < b ? { name: c.name, ret: +((eq[b] / eq[a] - 1) * 100).toFixed(1) } : null; }).filter(Boolean); }

const W = { 美股: .30, 动量: .20, 趋势: .15, 国债: .22, 黄金: .05, A股: .025, 港股: .025, 现金: .03 };

function makeBlocks(dates, trendSeries) {
  // 各block价格序列(归一不重要,用收益): 用ETF价; 趋势用传入的synthetic equity
  const bp = {}; const map = { 美股: 'SPY', 动量: 'MTUM', 国债: 'IEF', 黄金: 'GLD', A股: 'ASHR', 港股: 'FXI' };
  for (const k in map) bp[k] = dates.map(d => D[map[k]].get(d));
  bp['趋势'] = trendSeries; // already aligned array
  return bp;
}

// ===== 长窗(2014+, 趋势=代理) =====
const datesL = datesAll; const startL = 252;
const trendProxyL = buildTrendProxy(datesL, { SPY: datesL.map(d => D.SPY.get(d)), IEF: datesL.map(d => D.IEF.get(d)), GLD: datesL.map(d => D.GLD.get(d)), DBC: datesL.map(d => D.DBC.get(d)) });
const bpL = makeBlocks(datesL, trendProxyL);
const longVariants = {
  V0_base: sim(datesL, bpL, W, { start: startL }),
  V1_trend: sim(datesL, bpL, W, { start: startL, trend: true }),
  V2_voltgt: sim(datesL, bpL, W, { start: startL, targetVol: 0.10 }),
  V3_both: sim(datesL, bpL, W, { start: startL, trend: true, targetVol: 0.10 }),
};
const longM = {}, longC = {}; for (const k in longVariants) { longM[k] = metrics(longVariants[k], datesL, startL); longC[k] = crisisRet(longVariants[k], datesL); }
// 公平性复核: 现金赚3%货基收益后, overlay是否翻盘
const cashFair = {};
for (const [k, o] of [['V0_base', {}], ['V2_voltgt', { targetVol: 0.10 }], ['V3_both', { trend: true, targetVol: 0.10 }]]) {
  cashFair[k] = metrics(sim(datesL, bpL, W, { start: startL, cashYield: 0.03, ...o }), datesL, startL);
}

// 稳健性网格(V3 both, 长窗)
const grid = [];
for (const tv of [0.08, 0.10, 0.12]) for (const mn of [150, 200, 250]) {
  const eq = sim(datesL, bpL, W, { start: startL, trend: true, targetVol: tv, maN: mn });
  const m = metrics(eq, datesL, startL); grid.push({ targetVol: tv, maN: mn, sharpe: m.sharpe, calmar: m.calmar, cagr: m.cagr, mdd: m.mdd });
}

// ===== 短窗(DBMF可用起, 真CTA对比) =====
let ds2 = new Set([...ds].filter(d => D.DBMF.has(d)));
const datesS = [...ds2].filter(d => d >= '2018-01-01').sort();
// 找DBMF有≥252历史的起点
let startS = 0; for (let i = 0; i < datesS.length; i++) { if (i >= 252) { startS = i; break; } }
// 重新对齐短窗各price
function px(s, dates) { return dates.map(d => D[s].get(d)); }
const trendProxyS = buildTrendProxy(datesS, { SPY: px('SPY', datesS), IEF: px('IEF', datesS), GLD: px('GLD', datesS), DBC: px('DBC', datesS) });
const bpS_proxy = makeBlocks(datesS, trendProxyS);
const bpS_dbmf = makeBlocks(datesS, px('DBMF', datesS)); // 趋势腿=真DBMF
const shortVariants = {
  S0_base_proxy: sim(datesS, bpS_proxy, W, { start: startS }),
  S1_realCTA: sim(datesS, bpS_dbmf, W, { start: startS }),
  S2_realCTA_both: sim(datesS, bpS_dbmf, W, { start: startS, trend: true, targetVol: 0.10 }),
};
const shortM = {}, shortC = {}; for (const k in shortVariants) { shortM[k] = metrics(shortVariants[k], datesS, startS); shortC[k] = crisisRet(shortVariants[k], datesS); }

const out = {
  generatedAt: new Date().toISOString(),
  preregistered: { targetVol: 0.10, volWindow: 60, maN: 200, trendCadence: 'monthly', volCap: 1.0, riskSleeves: [...RISK], cost: '10bp双边', rf: 0.02, momentum: 'MTUM下沿(避幸存者偏差)' },
  long: { window: { start: datesL[startL], end: datesL[datesL.length - 1], years: +years(datesL[startL], datesL[datesL.length - 1]).toFixed(1) }, labels: { V0_base: '基线(现v3,代理趋势)', V1_trend: '+组合趋势开关', V2_voltgt: '+波动目标10%', V3_both: '+趋势开关+波动目标' }, metrics: longM, crises: longC },
  robustnessGrid: grid,
  cashYieldFairness: { note: '现金/减仓部分赚3%货基收益(对overlay更公平)后的复核', metrics: cashFair },
  short: { window: { start: datesS[startS], end: datesS[datesS.length - 1], years: +years(datesS[startS], datesS[datesS.length - 1]).toFixed(1) }, note: 'DBMF仅2019+, 样本短, 含2022(对趋势/CTA极有利), 谨慎解读', labels: { S0_base_proxy: '基线(代理趋势)', S1_realCTA: '真DBMF替趋势腿', S2_realCTA_both: '真DBMF+两overlay' }, metrics: shortM, crises: shortC },
};
mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, 'strategy-lab.json'), JSON.stringify(out, null, 2));
const pp = x => (x * 100).toFixed(1) + '%';
console.log('=== 长窗', out.long.window.start, '~', out.long.window.end, `(${out.long.window.years}y) 趋势=代理 ===`);
for (const k in longM) console.log(`  ${out.long.labels[k].padEnd(22)} CAGR ${pp(longM[k].cagr).padStart(7)} Sharpe ${longM[k].sharpe.toFixed(2)} Sortino ${longM[k].sortino.toFixed(2)} MaxDD ${pp(longM[k].mdd).padStart(7)} Calmar ${longM[k].calmar.toFixed(2)} vol ${pp(longM[k].vol)}`);
console.log('=== 稳健性网格(V3 both) Sharpe/Calmar ===');
for (const g of grid) console.log(`  tv${(g.targetVol * 100)}% ma${g.maN}: Sharpe ${g.sharpe.toFixed(2)} Calmar ${g.calmar.toFixed(2)} CAGR ${pp(g.cagr)} MaxDD ${pp(g.mdd)}`);
console.log('=== 公平性复核(现金赚3%) ===');
for (const k in cashFair) console.log(`  ${k.padEnd(12)} CAGR ${pp(cashFair[k].cagr).padStart(7)} Sharpe ${cashFair[k].sharpe.toFixed(2)} Calmar ${cashFair[k].calmar.toFixed(2)}`);
console.log('=== 短窗', out.short.window.start, '~', out.short.window.end, `(${out.short.window.years}y) 真CTA对比 ===`);
for (const k in shortM) console.log(`  ${out.short.labels[k].padEnd(20)} CAGR ${pp(shortM[k].cagr).padStart(7)} Sharpe ${shortM[k].sharpe.toFixed(2)} MaxDD ${pp(shortM[k].mdd).padStart(7)} Calmar ${shortM[k].calmar.toFixed(2)}`);
