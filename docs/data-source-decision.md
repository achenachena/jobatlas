# JobAtlas v2 数据源决策记录

> 2026-10-15 再次更新：负责人决定新增独立数据集 Employer boards（`dataset=ats`），只用 Greenhouse、Lever、Ashby 的公开职位接口（已登记为 `approved`，依据见 `backend/app/atlas/permissions.py`）；SmartRecruiters（API 的 robots 只允许 LinkedInBot）、Workday、BambooHR、Oracle、SuccessFactors 不用。与 Job Bank 并列、不相加；只存事实字段，不存职位描述。下表 ATS 一行为当时记录。

核查日期：2026-10-14。执行人：开发 agent。本文件不是法律意见；许可结论以官方原文为准，变化后重新核查。

## 1 结论

| 项目 | 结论 |
| --- | --- |
| 推荐真实数据源 | **Job Bank 开放数据**（ESDC，Open Government Licence – Canada 2.0）：逐条招聘广告，含首次发布日期、城市、省区、NOC 2021 职业代码 |
| 准入状态 | `approved`：公开许可明确覆盖复制、修改、发布、商业使用，条件是署名、不暗示政府背书 |
| 主要限制 | **按月发布，滞后约 2–8 天到 1 个月**。“最近七天”是“截至数据最新日期（`data_through`）的七天”，界面始终显示截止日期，不冒充实时 |
| 计量单位 | Job Bank 上发布的招聘广告（每条为一个工作地点的广告快照），**不是全加拿大招聘市场** |
| 历史 | 2023-01 至今共 45 个月逐日数据（每月文件即当月首次发布的全部广告，含已下架广告），可直接用于历史回放 |
| 其他候选 | 现有 ATS 来源、Adzuna 为 `pending`；LinkedIn 为 `blocked`；Statistics Canada 为 `approved` 但粒度不满足七天城市统计，未用于 7d 模式 |

## 2 候选对比

| 候选 | 官方证据 | 许可/权限 | 粒度与语义 | 实测 | 决定 |
| --- | --- | --- | --- | --- | --- |
| Job Bank 开放数据 | [数据集页面](https://open.canada.ca/data/en/dataset/ea639e28-c0fc-48bf-b5dd-b8899bd43072)；[OGL-Canada 2.0](https://open.canada.ca/en/open-government-licence-canada)（2026-10-14 访问） | 允许复制、修改、发布、翻译、分发、商业使用；须署名 "Contains information licensed under the Open Government Licence – Canada."；不得暗示官方地位或背书；不含个人信息与商标 | 逐条；`First Posting Date`（日期）、`City`、`Province/Territory`、`Work Location Postal Code`、`NOC21 Code`、`Job Title`、`External Indicator`、`Employment Term Telework`、`Vacancy Count` | 见 §3 | **采用**（approved） |
| 现有 ATS 来源（Greenhouse、Ashby、Lever、Workday、Oracle 等） | [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html)、[Ashby 公开职位接口](https://developers.ashbyhq.com/docs/public-job-posting-api) | 接口面向雇主自建招聘页；文档未明确允许第三方聚合、再发布和保存历史统计。robots 允许或无需登录**不等于**本作品用途获准 | 逐条；发布时间语义各异；只有 GTA 相关子集 | v1 已运行，约 1.1 万条在招职位 | `pending`，不进入 v2 统计 |
| Adzuna API | [条款](https://developer.adzuna.com/docs/terms_of_service)、[概览](https://developer.adzuna.com/overview) | 条款：试用外，商业/政府/学术机构的其他用途需另行约定；“may not be used … in aggregation” without written consent；默认限额 25 次/分、250 次/日、2,500 次/月；须展示 Adzuna 标识 | 职位查询、类别、地区统计；历史接口主要是薪资 | 无凭证，**未实测** | `pending`：需要书面同意 |
| Statistics Canada 职位空缺 | [开放许可](https://www.statcan.gc.ca/en/terms-conditions/open-licence)、[表 14-10-0444-01](https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1410044401) | 开放许可 | 季度、经济区域 | 未接入 | `approved`，但不能响应 `7d` 城市模式；**不替换进**最近七天模式 |
| LinkedIn 及类似平台的页面采集 | [LinkedIn 禁止抓取](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibition-of-scraping-software) | 条款禁止自动采集 | — | 仓库中的实验入口（`collect-job-leads.mjs`、`intake_watch.py`）已停止运行（2026-10-14） | `blocked` |
| Lightcast 等商业数据 | 供应商文档 | 需购买 | 城市、职业、月度 | 未询价 | 未评估；不购买（需用户预算） |

## 3 Job Bank 实测（2026-10-14）

数据来源：通过官方 CKAN 接口 `package_show` 列出资源，下载 2026 年 9 月英文 CSV（UTF-16 LE、制表符分隔，46 MB）。

| 指标 | 结果 |
| --- | --- |
| 可用月份 | 45 个英文文件：2023-01 至 2026-09；每月文件在次月 2–8 日发布 |
| 2026-09 行数 | 52,368；`WIC Job Location Snapshot ID` 无重复 |
| 日期范围 | 文件内 2026-09-01 至 2026-09-30，每天 1,496–3,269 条：每月文件即当月首次发布的广告 |
| 城市缺失 | 0.6%（`NA`） |
| 来源构成 | 外部合作招聘网站 30,108 条（`External Indicator=1`），雇主直接发布 22,260 条 |
| 远程标记 | 雇主直接发布记录有 `Telework`；外部记录为 `NA` |
| 职业样本（2026-09） | 软件开发（NOC 21230/21231/21232/21234）约 270；HR（10011/11200/12101）约 170；Bartenders（64301）200；标题含 barista 141 条，全部在 NOC 65201（食品柜台服务员等大类） |
| 城市样本 | Toronto 1,898、Calgary 1,677、Edmonton 1,645、Vancouver 1,385、Surrey 1,292、Québec 1,193、Montréal 1,078 |

语义说明：
- `First Posting Date` 是该广告**首次在 Job Bank 发布**的日期，只有日期没有时刻，保存为日期精度。外部来源的广告可能更早在原网站发布，因此口径写作“首次在 Job Bank 发布”。
- 每条记录是一个工作地点的广告快照；`Various Location` 在样本中全部为 `No`。每条广告只计入一个城市，因此全国去重总数等于全部记录数（含城市未确认）。
- 文件中 `Vacancy Count` 是空缺数，**不**用于默认指标（默认指标是广告数）。

## 4 推荐路线与运行约束

1. v2 真实模式只使用 Job Bank 开放数据；其他来源保持 `pending` 或 `blocked`，同步、查询、导出均执行准入判定。
2. 同步：每日通过 CKAN 检查数据集修改时间，发现新月份或已修改的月份时导入，导入完成后原子发布新版本。请求量为每月约 1 个 46 MB 文件。
3. 历史：首次运行回填 2023-01 起的全部月份；回填记为覆盖变化，不触发“新职位”提示。
4. 城市锚点：GeoNames（CC BY 4.0，需署名“GeoNames”）。省界和海岸：Natural Earth（公有领域）。
5. 署名：页面固定显示 OGL 署名、GeoNames 署名和 Natural Earth 致谢，不使用政府标志。

## 5 费用与配额

- Job Bank、Natural Earth、GeoNames：免费，无请求配额，按月少量下载。
- Adzuna：默认限额见上；超出需申请；未询价。
- 商业数据：未询价（需要用户预算和授权）。

## 6 未解决项

- **时效**：Job Bank 只能做到月度更新，无法满足“最近七天 = 今天往前七天”的实时理解。界面按“截至 data_through 的七天”展示；要做到实时，需要另一个已授权的实时来源（例如取得 Adzuna 书面同意）。这需要用户决定。
- **覆盖**：Job Bank 只是加拿大招聘市场的一部分（外部合作网站加雇主直接发布）。所有文案只描述“Job Bank 上发布的广告”。
- **咖啡师**：没有独立的 NOC 代码，按标题规则从 65201 中识别，规则和证据随分类版本保存。
