# 投资管家 · 个人组合策略 App

一个**云端、零本地依赖、可交互**的个人组合操作台。GPFG 式结构化组合（结构 + 纪律，**非 alpha**）。

- **在线访问**：开启 Pages 后为 `https://<用户名>.github.io/portfolio-butler/`
- **数据**：Yahoo Finance（免钥），每个**工作日北京时间 09:00** 由 GitHub Actions 自动刷新。
- **执行权在你**：本工具只产出"建议清单"——动量选股、断路器、目标配置、调仓指令。**你自己核对实时价并下单。** 绝不自动交易。

## 它做什么

| 模块 | 内容 |
|---|---|
| 今日指令 | 风险背景（SPY vs 200日均线 / 距高点回撤）+ 断路器状态 + 按当天日期提示该做哪类动作 |
| 动量池 | 今日动量选股（66 只宇宙里 252 日动量前 20 → 量比前 10，等权），含目标金额/股数 |
| 各板块目标 | 美股 SPY / 动量 / 趋势 DBMF / 国债 IEF / 黄金 GLD / A股 ASHR / 港股 FXI / 现金 |
| 调仓计算器 | 填当前持仓 → 出确切买卖股数；动量换股清单（卖跌出榜、买新进） |

## 策略一句话

美股 30% / 动量（唯一主动边，封顶 25%）20% / 趋势 15% / 国债 22% / 黄金 5% / A股 2.5% + 港股 2.5% / 现金 3%。
回测 Sharpe ≈ 0.82、最大回撤 −17.8%；对 60/40 全面跑赢，对纯股用约 2% 年化换一半回撤（活得久、睡得着）。
**断路器**：动量近 3 年跑输 SPY 超过 −10% 降半仓、超过 −25% 熔断退回 SPY（不是逃国债）。

## 架构

```
index.html                     交互应用(单文件, 读 data/latest.json)
engine/build-data.mjs          管家引擎: 抓行情→算动量/断路器/目标→写 data/latest.json
data/latest.json               最新数据(Actions 自动刷新)
.github/workflows/refresh.yml  定时引擎 + 自动发布 Pages
```

本地手动刷新：`node engine/build-data.mjs`（需 node + curl + 联网）。

## 一次性部署设置

1. 把本仓库推到 GitHub（公开仓库）。
2. 仓库 **Settings → Pages → Build and deployment → Source 选 "GitHub Actions"**。
3. **Settings → Actions → General → Workflow permissions** 选 "Read and write permissions"（让 Action 能提交数据回仓库）。
4. 到 **Actions** 页手动 Run 一次 `refresh-and-deploy`，几分钟后站点上线。之后每个工作日自动刷新。

## 纪律

机械、低频、不追新闻。资讯只作风险背景（全市场危机 → 断路器）。动量是唯一主动边，其余被动收 beta。
诚实预期 Sharpe≈0.82 是天花板，会跑输纯股的 FOMO 年份要扛住，别追 1.5（杠杆/幻觉）。

## 局限（诚实）

- 动量宇宙现为 66 只代表性大盘，有 survivorship 上沿偏差；真部署应接全标普 500 + 你的精确规则。
- 数据为隔日（工作日刷新），下单前请以券商实时价为准。
- 这是**结构化 beta 组合**，不是 alpha；价值在风控与纪律，不在跑赢。
