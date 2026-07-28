# LiteTavern Cloud：身份、Trial、Alpha 与额度

本文描述 LiteTavern（开源客户端）与 LiteTavern Cloud（官方托管服务）之间的边界，以及
Alpha 测试阶段的候补、批次、资格和额度机制。

本文只描述**当前仓库中已实现并有测试覆盖**的能力。未实现的部分在文末「尚未实现」中明确列出。

## 1. 产品边界

```text
LiteTavern（开源客户端，apps/web）
  界面、角色聊天体验、本地角色与缓存、BYOK、导入导出、调用 Cloud API

LiteTavern Cloud（托管服务，apps/api/src/modules/cloud/**）
  匿名身份、邮箱验证码账号、Trial 额度、Alpha 候补与批次、Alpha 额度、
  Model Gateway、用量与真实成本账本、云同步、备份恢复、限流与预算熔断、
  Founding Supporter、支持入口
```

由于 `LiteTavern Cloud` 仓库当前为空，本轮没有拆分独立仓库或微服务，而是在现有 API 应用内
建立清晰的模块边界：所有托管服务逻辑集中在 `apps/api/src/modules/cloud/`，核心聊天模块通过
显式的回调和 `gate.ts` 三个函数与之交互，不反向依赖。

### 客户端的独立部署

`apps/web` 可以构建为纯静态包并部署到 Cloudflare Pages、GitHub Pages、自定义域名或子路径：

| 配置 | 作用 |
| --- | --- |
| `VITE_CLOUD_BASE_URL` | 构建时写入的 Cloud 地址，同时加入构建产物的 CSP `connect-src` |
| `VITE_BASE_PATH` | 子路径部署（如 GitHub Pages 项目站点） |
| `public/litetavern-config.js` | 构建后仍可编辑的运行时覆盖（`window.__LITETAVERN__.cloudBaseUrl`） |

优先级：运行时配置 > 构建时变量 > 同源。客户端不内置任何 Cloud 平台 API Key。

## 2. 身份与注册

沿用既有实现，未重复建模：

```text
首次访问
→ POST /v1/identities/anonymous
→ 服务端创建 app_user + app_user_identity(ANONYMOUS)，写入 httpOnly Cookie
→ 发放一次性 Trial（app_user.free_quota_* + free_quota_ledger 的唯一 GRANT 行）
→ cloud_membership = ANONYMOUS_TRIAL

输入邮箱 → 6 位验证码 → 验证通过
→ 原匿名用户原地升级（user_id 不变，新增 EMAIL identity）
→ cloud_membership = REGISTERED_WAITLIST
```

关键保证及其实现位置：

- Cookie 存在即复用身份，刷新不会重复建号（`identity.ts`）。
- Trial 只发一次：`idx_free_quota_single_grant` 是 `free_quota_ledger` 上按用户的部分唯一索引。
- 注册幂等、并发不产生重复账号：`app_user_identity` 的 `UNIQUE(identity_type, subject_hash)`。
- 验证码有效期 10 分钟、一次性消费、5 次错误上限、发送冷却与每邮箱/每 IP 限流（`verification-codes.ts`）。
- 日志与埋点不记录验证码、完整邮箱、API Key 与聊天正文。

> **注册不等于获得 Alpha 资格。** 注册成功后用户处于「正式账号 + Alpha 候补」状态，
> 仍可使用本地能力和 BYOK，但没有 Alpha 平台额度。

## 3. Trial

Trial 由服务端配置（`FREE_QUOTA_INITIAL_COUNT`，默认 30 次回复），客户端不硬编码任何数值，
只显示 `/v1/cloud/status` 返回的剩余量。

目标是让用户走完一次核心价值闭环：开始聊天 → 形成共同经历 → 生成记忆 → 再次访问 → 召回记忆。
本文不承诺固定的永久 Trial 数量。

Trial 的发放、预占、扣减、释放全部记录在 `free_quota_ledger`，并受全局预算熔断和
`FreeTrafficGuard` 的单用户 / 单 IP / 全局速率与并发限制约束。

## 4. Alpha 候补、批次与放行

### 状态机

```text
ANONYMOUS_TRIAL ──注册──▶ REGISTERED_WAITLIST ──放行──▶ ALPHA_ACTIVE
                                                        │
                                          暂停 ◀────────┼────────▶ 结束
                                       ALPHA_PAUSED           ALPHA_ENDED
```

存储在 `cloud_membership`（每用户一行）。放行审计写入 `alpha_grant`。

### 动态分批

Alpha **没有固定总名额**。每一批的人数由运营者在创建批次时决定，写入 `alpha_batch.capacity`，
代码中没有任何写死的批次人数。批次同时携带自己的额度策略 `quota_policy_json`，
因此不同批次可以跑不同的额度配置。

放行时容量在事务内重新计数，超出容量的用户会被跳过并返回 `BATCH_FULL`；
`alpha_grant` 上的 `idx_alpha_grant_active_user` 保证一个用户同一时刻只有一条有效资格，
并发放行只会成功一次。

### 三条放行通道

| 通道 | grant_source | 说明 |
| --- | --- | --- |
| Founding Supporter 优先 | `SUPPORTER_PRIORITY` | 候补队列排序时排在前面 |
| 普通候补 | `WAITLIST` | 同一优先级内按加入时间先后 |
| 定向邀请 | `DIRECT_INVITE` | 指定 user_id，可绕过候补队列 |
| 管理员直接授予 | `ADMIN_GRANT` | 运营手动指定来源 |

Founding Supporter 只影响**排序**，不是唯一入口，也不带来额外额度。

## 5. Alpha 权益与额度

Alpha 用户获得完整但容量受控的体验：完整角色聊天、记忆生成与召回、关系摘要、
云同步与备份恢复、Alpha 身份标识，以及额度耗尽后切换 BYOK 的能力。

### 额度周期

`cloud_quota_cycle` 存储**明确的起止时间戳**，不在结构中写死「自然月」或「注册周年月」：

| 字段 | 含义 |
| --- | --- |
| `starts_at` / `ends_at` | 本期的绝对时间边界 |
| `granted_units` | 本期发放额度（来自批次策略） |
| `carried_units` | 结转额度，默认策略 `carry_over=false` 时恒为 0 |
| `consumed_units` / `reserved_units` | 已扣减 / 已预占 |

周期结束后首次访问时自动滚动到下一期；`idx_cloud_quota_cycle_active` 保证每用户只有一个
ACTIVE 周期，并发滚动只会开出一期。已经发放并开始的周期不会被无理由清零。

### 预占 → 结算 / 释放

```text
请求进入 → openPlatformGate  （检查全局预算 → 解析额度来源 → 预占 units）
成功     → settlePlatformGate（预占转扣减 + 写入真实成本 + 埋点）
失败     → abortPlatformGate （释放预占，失败不扣额度）
```

数据库层面的并发安全来自这条 UPDATE 的 WHERE 条件：

```sql
UPDATE cloud_quota_cycle
SET reserved_units = reserved_units + $units
WHERE cycle_id = $1 AND status = 'ACTIVE'
  AND granted_units + carried_units - consumed_units - reserved_units >= $units
```

配合 `CHECK (consumed_units + reserved_units <= granted_units + carried_units)`，
额度不可能透支或变成负数。`cloud_quota_ledger` 上的
`(cycle_id, request_id, action_type)` 唯一索引让预占 / 结算 / 释放各自幂等。

### 单次消耗与倍率

一次请求默认消耗 1 个 unit，可通过批次策略的 `model_multipliers` 为特定模型设置倍率，
并受 `max_units_per_request` 上限和 `daily_unit_limit` 单日上限约束。

### 客户端展示

客户端展示比例而非 Token：

> LiteTavern Cloud Alpha
> 本期额度剩余 68%

## 6. BYOK 边界

BYOK 请求不消耗 Trial，也不消耗 Alpha 额度，不经过 `gate.ts`。
用量仍写入 `model_usage_ledger`（`quota_source='BYOK'`、`quota_units=0`、成本 0），
用于可观测性，不计入平台成本。

API Key 只在验证和模型请求期间临时驻留内存，不落库、不进日志、不进埋点、不回显；
前端只保存在浏览器本地并掩码显示。服务端不接受用户 Key 作为公共额度池。

## 7. 真实成本账本

`model_usage_ledger` 每 `(generation_request_id, purpose)` 一行，`purpose` 区分
`MAIN_REPLY / SUMMARY / MEMORY / RELATIONSHIP / SUGGESTION / OTHER`，
因此主回复、摘要、记忆生成、关系摘要的成本可以分别统计。

记录内容：Provider、模型、输入 / 输出 / 缓存 Token、额度来源、扣减 units、
所属周期与批次、会话，以及按 `CLOUD_MODEL_PRICES` 计算的真实美元成本。
未配置价格时成本记为 0——这是「未计量」的诚实取值，不是估算。

`CLOUD_GLOBAL_MONTHLY_BUDGET_USD` 设为正数时启用全局预算熔断：当月平台支出达到上限后，
平台模型调用停止，BYOK 不受影响。

## 8. 云同步与降级

服务端是角色、会话、消息、记忆的事实来源，因此「同步」是每台设备的对账检查点：
`cloud_sync_state` 记录 `LOCAL / SYNCING / SYNCED / FAILED`、待同步数量、错误码和冲突计数。
冲突规则是简单且可解释的「服务端版本优先」：落后的设备会被标记 `stale` 并需要重新拉取。
本版本没有引入 CRDT。

Cloud 不可用时客户端的行为（`apps/web/src/lib/local-cache.ts`）：

- 联系人列表和已读会话从本地缓存渲染；
- 显示「LiteTavern Cloud 暂时不可用」，并明确说明数据没有丢失；
- BYOK 与本地视图继续可用；
- 上报 `FAILED` 检查点，恢复后可重试；
- 不把同步失败表述为数据丢失。

## 9. 导出

`GET /v1/cloud/export` 返回自描述的 JSON：

```json
{
  "format": "litetavern.export",
  "format_version": "1.0.0",
  "exported_at": "…",
  "data_types": ["user", "characters", "conversations", "messages",
                 "memories", "relationships", "model_configurations"],
  "compatibility": { "minimum_reader_version": "1.0.0", "app_version": "0.1.0", "notes": "…" }
}
```

导出不含任何密钥。导入方必须保留未知字段，不得静默丢弃。

## 10. 备份与恢复

```powershell
npm.cmd run backup --workspace @pomchat/api
npm.cmd run verify-backup --workspace @pomchat/api -- --snapshot .pomchat/backups/<stamp>
npm.cmd run restore --workspace @pomchat/api -- --snapshot .pomchat/backups/<stamp> --force
npm.cmd run prune-backups --workspace @pomchat/api -- --keep-days 14
```

**备份必须在 API 进程停止时执行**：PGlite 对数据目录持有排他锁，写入过程中的拷贝不是备份。

本仓库对「备份成功」的定义是**已验证可以恢复**：`runBackup` 只把作业标记为 `SUCCEEDED`，
只有 `verifyBackup` 重新校验全部文件 sha256、并真正打开恢复出来的副本执行查询之后，
才会标记为 `VERIFIED`。定时任务执行成功不算备份成功。

恢复是整库的时间点快照，不是操作重放；配合 Trial 单次 GRANT、周期单次 GRANT 和
`(request_id, action_type)` 幂等索引，恢复后重放同样的放行或结算操作不会重复发放或重复扣减
（`backup.test.ts` 覆盖）。

保留策略由 `pruneBackups` 按天数执行，并始终至少保留最近 3 份。

## 11. 埋点

LiteTavern Cloud 的程序事件用命名事实描述身份、额度和资格，而不是自由文本的
`action_name`，以便直接统计漏斗。名单定义在
`packages/contracts/src/schemas.ts` 的 `CLOUD_ANALYTICS_EVENT_NAMES`。

只有服务端能见证的事实（发放、放行、周期重置、备份恢复）由
`apps/api/src/modules/cloud/events.ts` 写入，与客户端事件共用 `analytics_event` 表，
因此一次查询即可跨两端计算漏斗。服务端写入的行不带 `anonymous_id`
（既有的客户端去重断言据此区分两类来源）。

| 分组 | 事件 | 触发端 | 关键属性 |
| --- | --- | --- | --- |
| 身份与注册 | `anonymous_created`、`registration_started`、`verification_code_sent`、`registration_completed` | 服务端 | — |
| Trial | `cloud_trial_granted`、`cloud_trial_used`、`cloud_trial_exhausted` | 服务端 | `trial_units`、`remaining`、`provider`、`model` |
| 候补与资格 | `alpha_waitlist_joined`、`alpha_batch_created`、`alpha_invitation_sent`、`alpha_granted`、`alpha_activated`、`alpha_paused`、`alpha_ended` | 服务端 | `batch_id`、`grant_source`、`founding_supporter`、`waited_seconds`、`channel` |
| Alpha 额度 | `alpha_quota_granted`、`alpha_quota_used`、`alpha_quota_exhausted`、`alpha_quota_cycle_reset` | 服务端 | `batch_id`、`cycle_units`、`cycle_days`、`units`、`remaining_ratio` |
| 核心价值 | `first_message_sent`、`return_visit` | Web | 角色、会话 ID、`session_number` |
| 核心价值（**已定义，尚未产出**） | `memory_generated`、`memory_recalled`、`core_memory_loop_completed` | — | 见下方说明 |
| 云服务 | `cloud_sync_succeeded`、`cloud_sync_failed`、`backup_created`、`restore_completed`、`restore_failed` | 服务端 | `pending_count`、`stale`、`error_code` |
| BYOK 与支持 | `byok_selected`、`support_entry_viewed`、`support_entry_clicked`、`founding_supporter_marked` | Web / 服务端 | `anonymous` |

属性禁止携带聊天正文、验证码、完整邮箱和 API Key：服务端由 `recordCloudEvent` 按属性名过滤，
客户端路径由 `analyticsPropertiesSchema` 在入口拦截。

> `memory_generated`、`memory_recalled`、`core_memory_loop_completed` 三个事件名已在契约中
> 定义，但**当前不会产出任何数据**：记忆抽取与摘要作业只写入 `system_postprocess_job` 队列，
> 本仓库尚无消费该队列的 worker。因此依赖这三个事件的指标（核心记忆闭环完成率）
> 现在无法计算，需在实现记忆管线时一并接入。

### 可计算的指标

- Trial 完成率、Trial → 注册转化率、注册 → 候补转化率、候补 → Alpha 激活率；
- 各批次激活率（按 `batch_id` 分组）。核心记忆闭环完成率待记忆管线接入后才可计算；
- Alpha 回访率与额度消耗速度（`alpha_quota_used` 的时间分布）；
- 额度耗尽发生在第几天（`alpha_quota_granted` 与 `alpha_quota_exhausted` 的时间差）；
- 耗尽后切换 BYOK / 点击支持 / 流失的比例；
- Founding Supporter 与普通用户的活跃差异（事件属性 `founding_supporter`）；
- 每用户 / 每批次的真实成本与错误率：`model_usage_ledger` 的
  `quota_source`、`batch_id`、`purpose`、`actual_cost_usd`、`status='REVERSED'`；
- 每批次是否在预算内：`GET /v1/cloud/admin/batches/:id/metrics`。

## 12. API

### 客户端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/cloud/status` | 身份类型、注册状态、候补状态、Alpha 资格与来源、批次、Founding Supporter、当前额度来源与剩余比例、周期起止、可执行的下一步 |
| POST | `/v1/cloud/waitlist` | 幂等加入 Alpha 候补 |
| GET | `/v1/cloud/support` | 支持入口配置、致谢名单、自动化程度 |
| GET | `/v1/cloud/export` | 导出全部用户数据 |
| GET | `/v1/cloud/sync` | 本账号各设备的同步状态 |
| POST | `/v1/cloud/sync/checkpoint` | 上报同步检查点（可重试、幂等） |

### 运营

所有 `/v1/cloud/admin/*` 需要 `x-litetavern-admin-token` 头。未配置 `CLOUD_ADMIN_TOKEN` 时
全部返回 404——默认部署没有管理面，也没有可猜测的默认凭证。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/cloud/admin/batches` | 创建批次（人数上限、额度策略、预算） |
| GET | `/v1/cloud/admin/batches` | 批次列表与已放行 / 剩余名额 |
| PATCH | `/v1/cloud/admin/batches/:id` | 调整容量、暂停放行、改额度策略 |
| GET | `/v1/cloud/admin/waitlist` | 候补队列（Founding Supporter 优先） |
| POST | `/v1/cloud/admin/batches/:id/release` | 按 `user_ids` 定向放行，或按 `count` 从候补池放行 |
| GET | `/v1/cloud/admin/batches/:id/metrics` | 本批人数、活跃、成本、错误数、是否在预算内 |
| POST | `/v1/cloud/admin/members/:userId/transition` | 暂停 / 恢复 / 结束某用户的 Alpha |
| POST | `/v1/cloud/admin/supporters` | 标记 Founding Supporter（按支付参考号幂等） |
| GET | `/v1/cloud/admin/budget` | 当月平台支出与熔断状态 |

## 13. Founding Supporter 与支持入口

Founding Supporter 是自愿贡献身份，不是商业套餐。权益限于：身份标识、下一批 Alpha 优先排序、
可选的致谢名单署名、新功能优先通知。不承诺无限额度、永久 Pro 或永久模型服务。

支付平台 URL、文案和是否展示致谢名单全部可配置，不与任何单一支付平台绑定。

**当前自动化程度：无支付回调。** 支持入口是外部链接，贡献由运营者人工确认后通过
`POST /v1/cloud/admin/supporters` 标记；该接口按 `external_reference` 幂等。
客户端界面明确写出了这一点。

## 14. 明确不承诺

Alpha 阶段不承诺无限额度、永久固定月额度、永久免费云存储、正式商业 SLA、永久 Alpha 身份、
Alpha 自动等于未来 Pro、Founding Supporter 永久获得高成本权益，或永久不变的模型与备份策略。

客户端始终展示：

> LiteTavern Cloud Alpha 仍处于测试阶段。额度、模型和云服务规则可能根据实际成本、
> 稳定性和测试结果进行调整。

已经发放并开始的额度周期不会被无理由清零。

## 15. 尚未实现

- 支付回调与自动标记 Founding Supporter（当前为外部链接 + 人工标记）。
- 异地容灾：备份与恢复在同一故障域内验证，**未**部署独立故障域副本，因此不声称具备异地容灾。
- 对象存储版本策略：当前资产为本地目录，备份随数据库快照一起拷贝。
- 备份失败告警：失败状态写入 `cloud_backup_job` 并以非零退出码返回，但没有接入外部告警通道。
- 定时备份调度：脚本已提供，未在本仓库内配置 cron / CI 定时任务。
- 完整导入端（导出已实现并测试；配套的 bundle 导入端尚未实现）。
