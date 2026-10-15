# JobAtlas v2：加拿大职位立体地图（统计口径与运行说明）

> 2026-10-15 更新：旧版数据和运行链路已执行退役清理。本文中旧版状态、迁移兼容或候选来源描述属于历史记录；当前运行与清理结果见 [清理记录](LEGACY_CLEANUP_2026-10-15.zh-CN.md) 和仓库 README。

对应规格：`docs/JOBATLAS_V2_DEVELOPMENT_SPEC.zh-CN.md`。数据源决策见 `docs/data-source-decision.md`，验证结果见 `docs/atlas-validation.md`。

## 1 统计口径

| 项 | 定义 |
| --- | --- |
| 指标 `new_postings` | 窗口内**首次在 Job Bank 发布**的去重招聘广告数。单位是广告（一条广告对应一个工作地点），不是招聘人数，也不是空缺总数（`Vacancy Count` 不参与计数） |
| 发布日期 | Job Bank `First Posting Date`，只有日期。不使用更新时间、导入时间或首次发现时间代替；没有可信日期的记录只计入质量统计 |
| 统计日 | America/Toronto 日历日。只有日期的记录归入它写明的那一天，不补造时刻 |
| 窗口 | `1d` / `7d` / `30d`：所选日期加前 N−1 个统计日，边界是当地零点构成的半开区间（跨夏令时仍是 7 个日历日，不是 168 小时）。默认 `7d`，首次打开停在最新数据日 |
| 最新数据日 | `data_through`：已完整导入的最后一个月的最后一天。Job Bank 按月发布，所以“最近七天”是**截至 data_through 的七天**，界面始终显示截止日期 |
| 去重 | 按来源 + 外部编号（`WIC Job Location Snapshot ID`）。2024 年 6–9 月的文件没有编号，改用整行内容指纹加文件内出现序号：同一文件重复导入结果相同，两条完全相同的广告仍按发布方给出的条数计 |
| 城市 | 记录写的市镇名加省份，匹配 GeoNames 的居民点（CC BY 4.0）。已合并的旧市镇按法定城市归并（如 North York、Scarborough 归入 Toronto；Saint-Laurent 归入 Montréal）。同一省内重名时取人口最多者，并记录规则。县、区域、经济区不并入城市层 |
| 城市未确认 | 记录没有可匹配的城市，计入全国总数和“城市未确认”，不放在任何城市上 |
| 远程 | 没有城市、`Telework = Yes` 的记录进入全国远程汇总（Job Bank 样本中暂无此类） |
| 全国总数 | 每条广告只属于一个城市，全国总数等于全部记录数（含城市未确认），不靠把城市数相加 |
| 0 与未知 | 0 表示覆盖范围内确实没有；`null` 表示未覆盖或数据缺口。地图上 0 画实心小底座，未知画虚线圆环 |
| 覆盖状态 | 每帧标注：`complete`（窗口全部覆盖）、`partial`（窗口早于历史起点，或当天未结束）、`missing`（窗口触及缺口）；版本过期标 `stale` |

### 职业分类（`app/atlas/occupations.py`，版本 2026.10.1）

先看 NOC 2021 职业代码，再看明确的标题规则（英文和法文），有歧义一律归为 `unclassified`，不会强行归类，也不使用雇主所在行业。

| ID | 规则 |
| --- | --- |
| `software_development` | NOC 21230/21231/21232/21234；或标题为软件工程师/开发者、全栈/前后端开发、SDE、programmeur、développeur logiciel 等 |
| `human_resources` | NOC 10011/11200/12101；招聘专员（recruiter、talent acquisition）按政策归入 HR |
| `bartender` | NOC 64301；barback 不算；标题同时写了 bartender 和 barista 的归为未分类 |
| `barista` | 没有独立的 NOC 代码（属于 65201），按标题识别 |
| `registered_nurse` | NOC 31301 |
| `cook` | NOC 63200 |
| `all` | 全部计入的记录，包括未分类的；不是各职业相加 |

## 2 架构

```
Job Bank CKAN ──(每日检查，按月导入)──▶ atlas_postings ──▶ atlas_daily_metrics(按版本)
            准入判定 atlas/permissions.py            │  原子发布 atlas_releases
GeoNames ──▶ atlas_cities                            ▼
                                   /api/v2/atlas/* ──▶ React + Three.js 沙盘 (apps/web/src/atlas)
```

- **来源准入**：`atlas_sources` 由代码中的 `REGISTRY` 同步，同步、发布、查询共用 `admitted()`。光有 `status="approved"` 不够，还必须有许可、条款链接、证据引用、核查日期，以及衍生统计和公开展示两项权限。权限失效后，版本立即停止对外提供。
- **示例数据**：`atlas/datasets.py` 的 `DemoDataset` 按请求即时生成（确定性：同一天同一参数结果相同），不写入数据库，`data_mode="demo"`、`dataset_id="demo-v1"`。真实请求失败返回 503 `DATA_SOURCE_NOT_CONFIGURED`，不会回退到示例数据。
- **版本**：每次发布写入一个新的 `release_id`，状态从 building 切到 published 在同一次提交内完成；保留最近 3 个版本，回放绑定在发布时的版本上。增量发布只重算有变化的月份，其余从上一版本复制；测试保证结果与全量重算一致。
- **固定比例尺**：发布时按“职业 × 窗口”算出整段历史的城市最大值，存在 `quality.scale_max` 里。前端在整段播放中锁定这个比例尺。默认所有职业共用 `all` 的最大值；“按职业缩放”需要用户主动切换，并在图例中标明。
- **v1 并存**：v1 的 GTA 街道级地图移到 `/legacy`，相关表和接口不变；v2 是新的表和 `/api/v2` 接口。

## 3 运行

```bash
# 迁移至当前版本（0015 删除旧版表，不可逆）
docker compose -f infra/compose.yaml run --rm migrate
# 首次：来源登记 + 城市库 + 全量导入（约 30 分钟，下载约 2 GB，逐月处理）
docker compose -f infra/compose.yaml run --rm --no-deps api jobatlas atlas-sources
docker compose -f infra/compose.yaml run --rm --no-deps api jobatlas atlas-cities
docker compose -f infra/compose.yaml run --rm --no-deps api jobatlas atlas-sync
# 规则变更后（不重新下载）
docker compose -f infra/compose.yaml run --rm --no-deps api jobatlas atlas-rematch   # 城市规则
docker compose -f infra/compose.yaml run --rm --no-deps api jobatlas atlas-release   # 全量重建并发布
```

- 定时任务：atlas 队列每日执行一次 `jobatlas.atlas_sync`，导入新增或修改过的月份，最多 3 个，然后增量发布。
- 网页：http://localhost:5173/。旧版入口已移除。示例数据：`?data=demo`；草案 B：`?draft=b`。
- 客户端每 60 秒查询一次 `/api/v2/atlas/version`（支持 ETag 和 304），页面隐藏时暂停。

## 4 备份与回滚

- 0015 退役不可逆，旧数据不会恢复。保留历史迁移仅用于现有数据库升级。
- 新版备份仅包含当前 atlas 表；不得通过恢复旧备份重新启用已退役数据。
- 数据纠错：发布方修订某月文件后，下次同步会重新导入该月，删除文件中已不存在的记录，并发布新版本（不改写旧版本）。

## 5 资产与许可

| 资产 | 来源 | 许可 | 用法 |
| --- | --- | --- | --- |
| 招聘广告记录 | Job Bank 开放数据（ESDC） | OGL-Canada 2.0；须署名，不得暗示官方背书 | 统计计数 |
| 城市锚点 | GeoNames `CA.zip` | CC BY 4.0（署名 “GeoNames”） | 城市位置和别名 |
| 省界、湖泊 | Natural Earth 1:50m | 公有领域 | `public/atlas/canada-geo.json`（由 `scripts/build-atlas-geo.mjs` 生成）。只画加拿大（负责人 2026-10-15 决定），不画邻国陆地；湖泊裁切到加拿大境内（构建时用 polygon-clipping，MIT 许可） |
| 字体 | Dela Gothic One、M PLUS Rounded 1c（@fontsource） | SIL OFL 1.1 | 界面文字 |
| 三维库 | three.js 0.186.1 | MIT | 渲染 |
| 建筑、纹理、海浪、山 | 代码绘制（`scene/textures.ts`、`AtlasScene.ts`） | 原创 | 无外部图片、模型或音效 |

页面的 “Sources & definitions” 弹窗列出全部署名，不使用任何政府标志。
