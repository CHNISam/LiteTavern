# 核心聊天基础设施重构

日期：2026-08-08
分支：`feature/chat-infrastructure-rebuild`
跨仓库：`LiteTavern`（开源客户端）+ `LiteTavern Cloud`（托管服务端）

## 真机故障与根因

真机现象：AI 回复流式生成后短暂显示，随后退回角色卡初始状态，历史不可见；额度扣减正常。

根因不是前端渲染，而是**一次没有做完的后端移植**：

`LiteTavern Cloud/docs/plans/2026-08-06-web-cloud-worker-d1-r2.md:104-110`（阶段 2）列出的
「角色、会话、消息的读写」从未接线。Worker 的路由表
（`apps/api/src/worker/index.ts:56-127`）只有 auth / providers / cloud-status / generations。

于是形成三个互不相通的后端：

| 运行环境 | transcript 实际存放 | 状态 |
|---|---|---|
| 本地 dev（`vite proxy → 127.0.0.1:3000`） | Cloud Fastify + PGlite，完整实现 | 正常 |
| **dev 真机**（`litetavern-dev.pages.dev`） | internal-gate D1（本仓库） | **只有开场白** |
| generation | Cloud Worker D1（另一个库） | 只写 `generation` / `quota_ledger` |

- internal-gate 的 `message` 表唯一写入点是建会话时插开场白
  （`deploy/internal-gate/api.js:947-957`）；全仓库没有第二处 `INSERT INTO message`。
- Cloud Worker 的 generation 路由不持久化任何 message
  （`apps/api/src/worker/routes/generation.ts` 全文无 message 写入）。
- 客户端在流结束后用 `fetchMessages()` 覆盖本地乐观状态
  （`apps/web/src/App.tsx:856`），拿回来的永远只有开场白。

## 第二个、更严重的缺陷：模型收不到上下文

分工契约本身是对的：客户端编译**本地资产**（persona、worldbook、regex 输出），
Cloud 从**自己的库**取角色卡与历史，再按 `Context Order` 装配。
（`docs/research/2026-07-30-sillytavern-runtime-compatibility.md`）

- 客户端**确实**发送了 persona 与 worldbook：`App.tsx:749` → `lore-runtime.ts:164-177`
  → `client_context.{persona, worldbook_entries}`，有测试断言
  （`RequestEconomy.test.tsx:192-196`、`lore-runtime.test.ts:74-78`）。
- 客户端**按设计不发**角色卡本体与历史——它们本该由服务端持有。
- 但 Worker 侧**两样都没有**：没有 character 表，`conversation` / `message` 表无人写；
  且 `toModelMessages()`（`generation.ts:473-478`）读的是 `payload.messages`，
  一个客户端从不发送的字段，`client_context` 被整体忽略。

因此当前每一次生成，模型实际收到的只有当前这一句话。
Fastify 侧实现了完整装配，Worker 侧一处都没有。

### 附带发现：已解析但从未进入生成链路的字段

`system_prompt`、`post_history_instructions`（服务端已存储，无人消费）、
`alternate_greetings`、`scenario` 与 `example_messages`（宏槽位存在但 `App.tsx:729-735`
从不填充，恒为空串）、`depth_prompt` / `talkativeness` / `fav`（被列入 `known` 故不报
"未应用"，但无任何消费者，静默丢失）、persona `title`、worldbook 的 `AT_DEPTH` 实际插入、
regex 的 `markdownOnly` / `promptOnly`。

### 附带发现：上下文静默失效路径

- `clientContextField` 在 `!characterId || !conversationId` 时返回 `{}`
  （`lore-runtime.ts:204`）→ 该轮完全没有 persona 与 worldbook，UI 无提示。
- worldbook 激活 Worker 75ms 超时（`worldbook-activation.ts:362-373`）
  → 该轮 `worldbook_entries` 为空数组，仅一条 warning 文案。
- `droppedForBudget` / `stoppedBy` / `timedOut` 停在客户端
  （`lore-runtime.ts:52-53`），服务端无从知晓上下文被裁剪过，也无法记入 provenance。

## 已存在、可复用的资产

不是从零重建。以下已经存在：

- `LiteTavern Cloud/packages/database/src/migration-sqlite.ts`：从 Postgres 完整移植的
  SQLite schema。`chat_message` 已有 `turn_no` / `variant_no` / `is_active_variant` /
  `reply_to_message_id` / `status(PENDING|STREAMING|COMPLETED|FAILED|CANCELLED|SUPERSEDED)`；
  `agent_generation_request` 已有 `UNIQUE(user_id, idempotency_key)` /
  `context_manifest_json` / `prompt_version` / token 计数；另有 `agent_session_summary`、
  `agent_memory`、`lore_worldbook`、`user_persona`。
- `AlphaD1Store` 已实现 `createConversation` / `findConversation` / `listConversations` /
  `appendMessage` / `listMessages`（`d1-store.ts:1050-1174`），**从未被路由调用**。
- `docs/solutions/integration-issues/real-roleplay-stress-gates.md`：Fastify 侧曾用真实
  Provider 跑通 16 轮，含世界书预算排序、Groq 推理参数、空正文不得记为 COMPLETED。
  这些规则在 Worker 侧全部缺失。

## 既定架构决策

### D1. 数据归属：全部迁往 Cloud，internal-gate 退回纯路由

依据：

1. `LiteTavern Cloud/docs/plans/2026-08-06-trial-removal-inventory.md:14` 已判定
   `deploy/internal-gate/api.js` **整体删除**。
2. 生产环境没有等价后端：`.github/workflows/deploy.yml` 的 `Add internal worker` 与
   `Apply internal D1 migrations` 都带 `if: github.ref_name != 'main'`；
   `apps/web/public/_redirects` 只有 SPA 回落；
   `scripts/validate-deployment-env.mjs` 强制 `main` 必须提供外部 `VITE_CLOUD_BASE_URL`。
   internal-gate 是 develop 专属临时桩，把长期数据模型建在它上面等于建在沙上。
3. 仓库边界（`AGENTS.md`）：账号、云同步、云备份属于 Cloud。跨设备恢复历史就是云同步。

结论：`chat_conversation` / `chat_message` / `agent_generation_request` 及其派生数据
全部由 Cloud 持有；`_worker.js` 只保留 `isCloudPath` 转发，`api.js` 与 internal-gate
的 D1 数据在迁移完成后退役。

### D2. schema 收敛到 `migration-sqlite.ts` 全量模型

Cloud 仓库内现存两套 schema：`alpha/migrations/0001_alpha_core.sql` 的
`account` + 扁平 `message`，与 `packages/database/src/migration-sqlite.ts` 的
`app_user` + `chat_message`。继续扩展前者会造出第三套数据模型。

收敛方向：Alpha 自有域（`account` / `session` / `alpha_claim` / `generation` /
`quota_ledger` / `email_verification` / `rate_limit`）保留不动，它们已经正确；
会话域改用全量 schema 的 `chat_conversation` / `chat_message` /
`agent_generation_request`，并建立 `account_id → app_user.user_id` 桥接。
`alpha_core.sql` 里未被路由使用的桩表 `conversation` / `message` 退役。

### D3. 身份模型：匿名服务端身份退役，游客本地优先

`trial-removal-inventory.md` 已判定「匿名身份与 initialQuota 整体取消」，
Worker 的 generation 对无账号请求返回 401 `GUEST`。当前客户端 `bootstrap()` 仍在调用
`/v1/identities/anonymous`，而 Worker 没有这条路由——这意味着**公开生产站点永远进不了
在线状态**，只会落到 `bootstrapOffline()`。

目标模型：

- **游客 / BYOK**：角色卡、Persona、Worldbook、Regex、会话全部本地（IndexedDB），
  浏览器内编译上下文，直连 Provider。服务端不持有任何 transcript。
- **Cloud 账号**：服务端是 transcript 的权威源，跨设备恢复。

### D4. Prompt 编译的分工

任务书要求「不要让客户端每次自行拼一坨未经服务端验证的历史，作为 Cloud 唯一事实来源」。
同时 BYOK 直连要求编译逻辑能在浏览器执行。因此：

- **历史**由 Cloud 从自己的 `chat_message` 构造，不接受客户端提交的历史作为事实源。
- **本地资产**（角色卡、Persona、Worldbook 激活结果、Regex 输出）由客户端编译后提交，
  Cloud 校验边界（长度、数量、权限）后按 `Context Order` 装配。
- 为了让 Cloud 能独立重建 prompt 并记录 provenance，客户端在**会话创建时**和**资产变更时**
  上传不可变的 **revision 快照**（`character_revision` / `persona_revision` /
  `worldbook_revision`），而不是每轮重传全文。会话绑定当前 revision；
  每次 generation 记录实际使用的 revision id。

这同时满足三件事：服务端可验证、跨设备可渲染、provenance 可解释。

### D5. Portrait / Landscape 双一等公民

不强制横屏。当前 `900px` 与 `960px landscape` 两个断点区间重叠
（844×390 同时命中），横屏块只能靠 `!important`（`styles.css:1508`）和源序取胜。
改为互斥条件，并把 `.contact-rail` 的显隐从「JS `view==='chat'` + CSS `:has` + `!important`」
三轨统一到单一机制。

星铁视觉语言与布局解耦（集中在 `:root` token、`.hsr-app` 伪元素、
`.message-bubble` 硬阴影切角、`.rail-dark .selected` 近白描边），重做栅格不动这些。

`scripts/responsive-layout.test.mjs` 是对 CSS 原文做正则与源序比较的契约测试，
钉死了横屏块的 `30vw` / `56px` / `100dvh` 表达式和两处规则的文件内相对顺序。
布局语义变更属于「修改测试中的业务预期」，按 `AGENTS.md` 需同步更新测试并说明理由。

软键盘目前完全没有处理（无 `visualViewport`、无 `interactive-widget`、只有 `dvh`），
在本阶段一并补齐。

## 分阶段交付

### 阶段 A —— 闭环（本次首要目标）

目标：真机连续聊天正常、回复不消失、刷新历史仍在、模型真正收到角色卡与历史。

#### A0. 身份与 schema 的收敛方式（定稿）

Worker 的 `account`（Alpha 域）与全量 schema 的 `app_user` 是两套身份体系。
一次性把 `migration-sqlite.ts` 的 50 张表整体接上会同时引入第二套身份和大量当前
用不到的表，风险与本次目标不匹配。因此：

- 新增 D1 迁移 `0003_conversation_domain.sql`，建 `chat_conversation` /
  `chat_message` / `agent_generation_request`，**列结构逐列对齐
  `migration-sqlite.ts` 的同名表**，仅把 owner 列换成
  `account_id REFERENCES account(account_id)`。
- 未来收敛到全量 schema 时，差异只剩 owner 列名，不是重新建模。
- `0001_alpha_core.sql` 的桩表 `conversation` / `message` 在迁移中把既有行搬入新表后停用，
  不直接 DROP（dev 环境已有数据，不得静默丢弃）。

#### A1. 角色卡如何到达 Cloud：revision 快照

Cloud 没有 character 表，角色卡是客户端本地资产（仓库边界）。因此不把 character 表
整体搬到 Cloud，而是：

- 新增 `character_revision`（不可变快照：`revision_id`、`account_id`、
  `character_id`、`content_hash`、`normalized_data` JSON、`created_at`）。
- 客户端在**创建会话时**和**角色卡内容哈希变化时**上传快照；
  `content_hash` 唯一，重复上传是 no-op。
- `chat_conversation.character_revision_id` 绑定当前 revision；
  `agent_generation_request` 记录本轮实际使用的 revision id（provenance 起点）。
- persona 与 worldbook 沿用现有 `client_context` 逐轮提交（它们本就是逐轮激活结果），
  阶段 B 再补它们的 revision 快照。

#### A2. 服务端 prompt 装配

把 `apps/api/src/modules/context-assembler.ts` 的装配顺序移植到 Worker
（PG 查询改 D1 查询，5 组查询均为纯读）。历史从 `chat_message` 取
（`status='COMPLETED' AND is_active_variant=1`），角色卡取自绑定的
`character_revision`，persona / worldbook 取自请求的 `client_context`。

`generation.ts` 的 `payload.messages` 与 `payload.system` 入口**删除**——
客户端从不发送它们，保留只会让"客户端可以自带历史"成为可用后门。

#### A3. Message 生命周期

```
submit
→ 事务①：落 USER message(COMPLETED) + agent_generation_request(GENERATING)
          + ASSISTANT 占位(STREAMING) + 推进 next_sequence_no/next_turn_no
→ 装配 prompt（USER message 已在库，历史天然包含本轮）
→ provider 流式
→ 首个可见正文 → 结算额度（现有 EffectiveBodyDetector 门控不变）
→ 事务②：ASSISTANT → COMPLETED + token_count；request → COMPLETED
```

失败与中断：

- provider 失败且无可见正文 → ASSISTANT `FAILED`，额度释放，**USER message 保留**。
- 有可见正文后中断 → ASSISTANT `INCOMPLETE`，保留已展示正文，额度已计入。
- 空正文 → 沿用现有 `EMPTY_RESPONSE`，不得记为 `COMPLETED`
  （`real-roleplay-stress-gates.md` 已确立的规则）。

#### A4. 路由与转发

- Cloud 新增：`POST /v1/conversations`、`GET /v1/conversations/:id/messages`、
  `POST /v1/character-revisions`。
- `deploy/internal-gate/_worker.js` 的 `isCloudPath` 扩展到这些路径；
  `api.js` 对应实现停止提供数据。角色导入、头像、导出等仍暂留 internal-gate，
  在阶段 F 随存量迁移一并退役。

#### A5. 客户端

`submit()` 流结束后不再无条件 `setMessages(loaded)`：以服务端返回的
`message_id` / `sequence_no` 对齐本地乐观行，只有对齐失败才整表重拉。
`fetchMessages` 的空结果不得覆盖非空本地状态。

### 阶段 B —— Message Graph 与幂等

`parent_id` 语义化、`current_head_id`、`client_message_id` 唯一约束、
Regenerate / Swipe / Edit / Branch、Retry 与 Regenerate 的语义区分、
乐观并发与 `conflict_pending`、provenance revision 完整记录。

### 阶段 C —— Prompt / Context Compiler

`PromptCompiler` / `ContextBudgetManager` / `WorldBookResolver` / `MemoryProvider` /
`HistoricalRetriever` / `CompactionStrategy`。以 token budget 取代
Fastify 侧遗留的 30-message 固定窗口。Canonical Transcript 与 LLM Working Context 分离。

### 阶段 D —— Storage 分层与生命周期

`StorageTier` 抽象、D1 用量监控、archive planner、segment sealer、
D1 → R2 迁移与 checksum、透明 hydration、GC、Archive 与 Delete 的语义区分。

### 阶段 E —— 客户端与 UI

conversation store 重构；portrait / landscape 双一等公民；软键盘处理。

### 阶段 F —— 迁移与验收

internal-gate D1 存量数据迁入 Cloud；全量测试；真机端到端验收。

## 验收标准

```
导入/选择 Character → 创建 Conversation → 连续多轮
→ 模型真正使用 Character + History
→ 回复稳定展示 → 刷新 → 消息全部恢复
→ 继续聊天 → 换设备载入 → 历史仍正确
```

并证明额度只扣一次，且角色卡确实进入 generation context（而非仅显示在 UI）。

## 进度

### 阶段 B —— Message Graph 与幂等（已完成）

Cloud 迁移 `0005_message_graph.sql`，全部为增量列/索引，边仍只有 `reply_to_message_id`。

- `chat_conversation.current_head_id`：客户端回传 `expected_head_id`，守卫写在
  分配 sequence 的同一条 `UPDATE ... WHERE` 里；不带该字段的旧客户端不受限制而非被拒。
- **Regenerate**：在同一条 USER 消息下新增 variant，旧回复 `is_active_variant=0`
  但**不**置 SUPERSEDED（否则 swipe 列表为空）；其后续消息才置 SUPERSEDED。
- **Retry**：原地重试 FAILED 回复，不占新 sequence、不新增消息行，新开一条
  `agent_generation_request(kind='RETRY', attempt_no=n+1)`。
  是 Retry 还是 Regenerate 由**目标消息的状态**决定，不接受客户端指定。
- **Swipe**：`activateVariant` 仅允许在会话末尾切换；中间切换等同于删除其后内容，
  按编辑处理而非导航，直接拒绝。
- **Branch**：`branched_from_*`，前缀复制（不共享指针）；
  `chat_conversation_account_character_uq` 改为排除分支，而不是删除该约束。
- **Provenance**：新增 `context_revision`（PERSONA / WORLDBOOK_ENTRY，按内容哈希去重），
  `agent_generation_request` 记录 `persona_revision_id` / `worldbook_revision_ids`。
  稳态是一次读、零写。
- 冲突码分离：`HEAD_MISMATCH` / `DUPLICATE_MESSAGE` / `MESSAGE_STATE_CONFLICT` /
  `CONVERSATION_CONFLICT`（仅后者可重试）。
- 新路由：`GET|POST /v1/conversations/:cid/messages/:mid/{variants,activate}`、
  `POST /v1/conversations/:cid/branches`。
- 测试：`worker/routes/message-graph.test.ts`（21 例）。变异验证：去掉 head 预检查、
  把被替换的 variant 置为 SUPERSEDED，均被测试捕获。

### 阶段 C —— Prompt / Context Compiler（已完成）

`messages.slice(-30)` 已删除。

- `token-budget.ts`：字符级估算（CJK 1 token/字，其余 1/3），**故意高估**——
  低估会撑爆窗口导致整轮失败，高估只是多丢一条旧消息。真实 token 数仍由 provider 返回并入库。
- `prompt-compiler.ts`：Canonical Transcript 与 LLM Working Context 分离；
  先量 system 块（含角色卡、世界书、persona、摘要、memory）再决定历史容量；
  最后一条消息无论多大都必发。产出 `budget` manifest（丢了几条、可压缩到哪条）。
- `0006_working_memory.sql`：`agent_session_summary`（压缩）+ `agent_memory`（长期事实）。
  两者都**不是事实源**，可删可重建。`agent_memory` 默认 `CANDIDATE`，
  抽取只负责提议；`subject_key` 唯一索引保证同一事实只有一条 ACTIVE。
- `compaction.ts`：绝不在请求路径内执行，挂在 `ctx.waitUntil`；
  版本号唯一约束使并发压缩只有一个真正调用模型；空摘要记 FAILED 而非 READY
  （否则它会"覆盖"一段谁也不再回头处理的对话）。
- `HISTORY_CEILING = 200` 是**成本护栏**，不是上下文规则。
- 测试：`prompt-compiler.test.ts`（12 例）、`compaction.test.ts`（11 例）。

### 阶段 D —— Storage 分层与生命周期（已完成）

- `0007_storage_tiers.sql`：`chat_segment`（SEALING→SEALED→VERIFIED→PRUNED）、
  `chat_conversation.pruned_through_sequence_no`、`deleted_conversation` 墓碑表。
- `archiver.ts`：写对象 → **读回** → 比对 checksum → 才删 D1 行。
  `pruneSegment` 守卫在 `state='VERIFIED'`，无法从"写返回了"直接跳到删除。
  最近 60 条永不下沉（否则把 R2 往返放到了请求路径上最热的数据上）。
- `readTranscript` 透明 hydration：调用方无法分辨消息来自哪一层。
  从未归档的会话零 R2 请求。对象缺失**报错**而不是返回半截历史。
- **Delete 真的删除**：消息、generation request、摘要、memory、provenance、R2 对象
  全部移除，只留 `deleted_conversation`（id + 时间 + character_id，无内容）。
  Archive 是另一个端点，一字不动、可撤销。原先的 `status='DELETED'` 就是
  §15 所禁止的"永久 soft delete 冒充删除"。
- **归档水位必须落后于压缩水位**（本阶段发现并修掉的一个隐性缺陷）：
  prompt compiler 从 D1 读历史、用摘要顶替更早的部分，而两个水位由两套规则决定
  （一个是 token 预算，一个是消息条数），没有任何机制让它们对齐。
  归档若跑在压缩前面，就会删掉 compiler 本该发送、且没有任何摘要描述的消息——
  没有报错，只是角色忘掉了那几天。因此 `sealNextSegment` 的上界取
  `min(head - keepRecent, 当前 READY 摘要的 coverage_end, start + MAX_SEGMENT - 1)`；
  没有摘要就一行都不能删。这也是 `recentActiveMessages` 可以只读 D1 的前提。
- Sealing 与 compaction 一样挂在 `waitUntil`，不用 cron：
  只有"有人在聊"才是会话在增长的信号。
- `TRANSCRIPTS_BUCKET` 与 `ASSETS_BUCKET` 分开（生命周期与访问策略不同），
  且**可选**——未绑定时全部留在 D1，是成本问题不是故障。
- 测试：`archiver.test.ts`（15 例）。变异验证：去掉 checksum 比对、
  去掉 VERIFIED 守卫，均被捕获。

### 阶段 E —— 客户端与 UI（已完成）

- **Portrait / Landscape 互斥**：`(max-width: 900px)` 块加上
  `and (not ((max-width: 960px) and (orientation: landscape)))`。
  844×390 过去同时命中两块，横屏块只靠源序与 `!important` 取胜——那不是布局系统，
  是两套布局在打架。`display: flex !important` 已删除。**没有强制横屏**。
- `.contact-rail` 的 `:has(.contact-item.selected)` 改为 `data-has-selection`：
  CSS 读取被陈述的事实，而不是从后代 class 名反推。
  （JS 侧的 `view === 'chat'` 保留：那是路由，与布局是两件事。）
- **软键盘**：viewport meta 加 `interactive-widget=resizes-content`（Android）；
  `lib/keyboard-inset.ts` 用 `visualViewport` 发布 `--keyboard-inset`（iOS 忽略前者）。
  `.reply-area` 用 `max(--safe-bottom, --keyboard-inset)`——两者不会同时出现。
  阈值 120px 过滤地址栏收缩与 pinch-zoom；计入 `offsetTop`（iOS 会同时滚动 visual viewport）。
- **客户端 conversation store**：`headIdRef` 记录服务端 head，随会话切换清空，
  发送时带 `expected_head_id`（没读过就不带——猜一个比不说更糟）。
  `HEAD_MISMATCH` / `DUPLICATE_MESSAGE` 不重试、不报错，直接重读服务端分支。
- 测试：`keyboard-inset.test.ts`（6 例）、`responsive-layout.test.mjs` 新增 2 例。

### 阶段 F —— 迁移（部分完成）

- `legacy-import.ts`：internal-gate D1 → Cloud schema 的导入器。
  **拒绝猜测归属**：匿名身份已退役，没有任何地方记录哪个匿名 id 对应哪个人，
  因此账号映射由操作者显式提供，映射不到的 legacy user 记入 `unmappedUsers`
  而不是丢弃或归并。sequence 重新致密编号（旧表允许空洞，留着会让
  `next_sequence_no` 与实际行不一致，之后每一次发送都被守卫判为并发写而永久拒绝）。
  已存在的会话一律跳过——旧库是临时桩，此后写在这里的才是真的。
  幂等，可重复运行。测试 `legacy-import.test.ts`（9 例）。

### 已完成（阶段 A 服务端 + 客户端止血）

**LiteTavern Cloud**

- `apps/api/src/modules/cloud/alpha/migrations/0003_conversation_domain.sql`：
  `character_revision` / `chat_conversation` / `agent_generation_request` /
  `chat_message`。0001 的桩表 `conversation` / `message` 保留未删。
- `apps/api/src/modules/conversation/d1-store.ts`：`ConversationD1Store`。
  与 `AlphaD1Store` 分离。`openTurn` 在一个 `batch()` 内写入
  USER + generation_request + ASSISTANT 占位并推进序号，序号计数器带守卫，
  并发轮次不会分配到同一个 `sequence_no`。
- `apps/api/src/modules/conversation/prompt-assembler.ts`：按 `Context Order` 装配。
- `apps/api/src/worker/routes/conversations.ts`：`POST /v1/conversations`（带卡）、
  `GET /v1/conversations/:id/messages`。
- `apps/api/src/worker/routes/generation.ts`：删除 `payload.messages` 与
  `payload.system` 入口；先落 USER 再调 provider；
  COMPLETED / INCOMPLETE / FAILED 三种落库结局。
- `apps/api/src/worker/routes/transcript.test.ts`：12 个新用例。

**LiteTavern（客户端）**

- `deploy/internal-gate/_worker.js`：`/v1/conversations` 与
  `/v1/conversations/:id/messages` 转发给 Cloud。
- `deploy/internal-gate/api.js`：移除这两条路由的本地实现。
- `apps/web/src/App.tsx`：开会话时携带角色卡；流结束后只在服务端分支**确实包含本轮**
  时才采用它；未登录（`GUEST`）不再让整个 bootstrap 掉进离线模式。
- `apps/web/src/TranscriptRecovery.test.tsx`：3 个新用例。

### 阶段 E 补完 —— Regenerate 与 Swipe 接线（已完成，v0.1.0 release blocker）

纯前端 + 网关路由表，未改 schema、未改 Cloud。

- **Regenerate 之前是假的**：旧实现把"重新生成"做成"用上一条 USER 消息触发一次
  edit 重发"。那会写一条新的 USER 消息、把原来的一问一答挤出活动分支，
  于是**没有任何东西指回被替换掉的回复**——一个悄悄销毁答案的按钮。
  现在只发 `regenerate_of_message_id`，不带 `input`、不带 `client_message_id`：
  USER 消息原地不动，新回复作为同一父消息下的另一个 variant 落库。
  Retry 还是 Regenerate 由服务端按目标消息状态判定，客户端不指定。
- **Regenerate 与 Swipe 是同一个功能**：regenerate 是唯一会产生第二条回复的动作，
  swipe 是唯一能让第一条重新可达的动作。只接其中一个没有意义。
- **两者都只出现在会话末尾的那条回复上。** `activateVariant` 本来就拒绝在中间切换
  （等同于删除其后内容，属编辑而非导航）；regenerate 中间消息虽然服务端允许，
  但效果同样是丢掉后续对话——一个会静默截断历史的按钮不值得提供。
  开场白也排除：它不回答任何消息，服务端会以 `WRONG_STATE` 拒绝。
- Swipe 点击时**实时读 variant 列表**而不是用 transcript 里缓存的计数：
  另一台设备可能已经加了回复，用陈旧列表会激活错的那条。两端不循环。
- 客户端上下文按"这条 USER 消息正要被发送"重建：历史截到该 USER 消息之前，
  其文本充当 input 的位置。被替换的回复不参与世界书激活扫描——
  否则条目会被模型即将重写的那段文字触发。USER_INPUT 的 Regex 不再跑第二遍
  （那段文本发送时已处理过，服务端存的是处理后的结果）。
- 失败路径：generation 失败时把被乐观移除的旧回复重新拉回来，
  而不是留给读者一个缺了一块的会话。旧的 structured turn 端点不支持 variant，
  regenerate 不走那条兼容回退。
- `deploy/cloud-gateway.js`：`.../messages/:mid/variants` 与 `.../activate` 转发 Cloud。
- 测试：`apps/web/src/RegenerateSwipe.test.tsx`（4 例）、
  `scripts/internal-gate-routing.test.mjs` 新增断言。

### 未完成

- **Branch 的 UI 未接线，明确 defer（不属于 v0.1.0）。** 服务端
  `POST /v1/conversations/:cid/branches` 齐备且有测试，缺的不是接线而是客户端的
  会话模型：现在"一个角色 = 一个会话"，`conversationId` 由
  `POST /v1/conversations` 按 `character_id` 取回，界面上没有会话列表也没有切换器。
  分支会话被 `chat_conversation_account_character_uq` 排除在外，
  所以创建之后再打开这个角色仍然回到原会话——**刷新一次分支就找不回来了**。
  要让它可用得先有会话列表、活动会话的持久化与切换 UI，
  那是新的状态模型和新的界面，不是接线。
- **角色、头像、导出、model-configurations 仍在 internal-gate。**
  搬迁需要在 Cloud 建角色域（表 + 路由 + R2 头像 + 导出），
  且**取决于 Open Question 1 的答复**：生产站点是否现在切到 Cloud。
  在方向确定前做这块有做反的风险，因此未开工。
- **真机端到端验收未做。** 需要 push + CI 部署，本机无法访问 `api.cloudflare.com`
  （见 Cloud 仓库的部署工作流说明），且部署属于对外动作，等你确认。
- **`TRANSCRIPTS_BUCKET` 桶尚未创建**（`litetavern-cloud-dev-transcripts` /
  `litetavern-cloud-production-transcripts`）。绑定是可选的，未创建时归档不发生、
  全部留在 D1，服务正常；创建后归档自动开始。
- **Memory 的抽取环节未实现。** `agent_memory` 的读取、去重、注入、删除都已就绪并有测试，
  但"从对话中提炼出候选事实"这一步还没有写。缺它的表现是 memory 永远为空，
  而不是错误的 memory 被注入——这是刻意选择的失败方向。
- **账号级删除未实现。** 会话级删除是完整的；但 `context_revision`（persona /
  世界书条目的内容快照）是按内容哈希跨会话共享的账号级数据，删一个会话不能删它们，
  否则会删掉别的会话还在用的文本。清理它们属于"删除账号"这条流程，目前不存在。
  这里明确记下，而不是留给以后的人去发现。
- 客户端 `deleteUserMessage`、编辑重发、重新生成三条路径仍走旧的整表重拉语义。
- **代写（`reply-suggestions`）等待 Cloud 侧实现。** 这是重建时漏掉的尾巴：
  `POST /v1/conversations/:cid/reply-suggestions` 不在网关路由表里，请求落进
  internal-gate 被那条兜底 503 接住，于是"代写"按钮在模型服务完全正常的开发环境上
  报"内测环境的模型服务尚未启用"——把一个缺路由说成了缺服务。
  网关这侧已经补上（`deploy/cloud-gateway.js`，`scripts/internal-gate-routing.test.mjs`
  有断言），**但 Cloud 仓库尚未实现这条路由**，在它落地之前点代写会从 503 变成 404。
  另外 `App.tsx:1125` 那条"复用上一轮 suggestions"的快路径已经死了：suggestions 只由
  旧的 structured turn 端点返回，而正常发消息走 SSE 的 `/generations`，
  所以聊天框上方那条快捷回复建议条现在永远不显示，代写也每次都要真发一次请求。
  Cloud 接好后要决定：是让 `/generations` 的 done 帧带回 suggestions（省一次调用），
  还是把那条建议条一并下掉。

## Open Questions

1. 生产环境（`main`）目前没有任何后端，且 `bootstrap()` 调用的
   `/v1/identities/anonymous` 在 Cloud Worker 上不存在。公开站点是否应当在
   本阶段就切到 Cloud，还是继续保持"仅 develop 可用"？这决定阶段 F 的迁移目标。
2. BYOK 当前不是浏览器直连 Provider：`api_key` 每轮以明文 JSON 经 Cloud Worker
   转发（`App.tsx:629-635` → `_worker.js:99`）。任务书 §18 假设的是直连。
   是否要改为真正的浏览器直连（需要客户端具备完整 PromptCompiler，即阶段 C 的
   共享编译器落地后才可能）？
