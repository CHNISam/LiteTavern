# LiteTavern：AI 角色世界主线核查与最小纵向切片

日期：2026-07-28

## 结论

核查前的 LiteTavern（历史包名 PomChat）已经具备可复用的角色聊天基础，但尚不具备可验证的持续因果世界。

现有系统能恢复聊天上下文、注入自然语言记忆和关系摘要，却不能可靠回答“发生了什么、谁知道、关系为何变化、哪个事实约束了哪个决策”。自由文本记忆可由用户删除，关系变化没有原因账本，角色计划与既成事实没有权威层级，角色卡自定义 Prompt 也位于事实约束之外。数据库中的后置任务只有入队，没有执行器。

因此，本轮不扩地图、多角色社会、小手机或 Galgame 资产，先建立可信历史边界与确定性因果内核。

## 仓库核查

### 可以复用

| 能力 | 证据 | 用于新主线 |
| --- | --- | --- |
| 角色定义与版本 | `agent_character`、`agent_character_card_version` | 继续承载稳定身份、背景、性格和表达 |
| 用户隔离 | 所有会话、记忆、关系查询均带 `user_id` | 隔离不同玩家的世界线 |
| 会话与消息顺序 | `chat_conversation`、`chat_message`、turn/sequence | 继续作为聊天演出通道，不再作为世界本体 |
| 多气泡演出 | 一次生成、前端确定性播放、逐条落库 | 复用为一种演出形式 |
| Context 装配 | `assembleContext` | 增加最高优先级的世界正史层 |
| 长期记忆来源 | `agent_memory_source` 可关联消息 | 可作为回忆/召回材料，但不能替代正史 |
| 关系资料导入 | `agent_relationship.state_json` | 保留兼容；后续只能作为背景资料，不能冒充因果账本 |
| `EVENT` 消息 | 前端已能渲染 | 本切片唯一新增演出出口 |
| Context manifest | 生成请求已保存上下文清单 | 扩展为记录 world/fact/decision 引用 |
| PGlite 迁移与测试 | 版本化迁移、内存与持久化测试 | 承载最小正史模型 |

### 仍停留在普通聊天产品层

1. `agent_memory` 的 `FACT/COMMITMENT` 只是自然语言分类。它可以被删除或 supersede，没有客观参与者、场景、结果、知情者、决策引用或 append-only 约束。
2. `agent_session_summary` 是聊天压缩结构，不是世界历史；当前运行时也没有读取它。
3. `agent_relationship` 只有摘要与自由 JSON，没有“哪件事导致哪一维关系变化”的账本。
4. `system_postprocess_job` 只创建 `EXTRACT_MEMORY/UPDATE_SUMMARY` 任务；仓库中没有执行任务、提取记忆或更新摘要的 worker。
5. Context 只取最近 30 条消息和最多 12 条记忆。重要事实可能因为排序和窗口变化消失。
6. 角色卡 `system_prompt` 可以替换默认 Prompt，`post_history_instructions` 也能追加要求；此前没有更高权威的不可变历史层。
7. “角色知道什么”和“客观发生什么”没有区分；情绪、关系、计划也混在摘要或自由 JSON 中。
8. 用户编辑旧消息会把后续消息标为 `SUPERSEDED`。聊天分支可以改写，但此前没有独立正史防止已经落地的世界事件随聊天编辑消失。
9. 前端 `App.tsx` 用单个 `conversationId` 和 `chat/profile/memories/settings` 本地视图驱动整个产品，路由和状态模型均以聊天角色为中心。

### 对核心因果闭环帮助有限的横向扩张

当前 Provider 扩展、连接系统、更多角色卡格式、多气泡节奏、登录套餐、完整关系迁移 UI、更多视觉页面，均可提升可用性或获客，但不能证明两个玩家会走向持续不同的未来。它们不应成为下一主线。

## 对七个核查问题的直接回答

1. 原项目没有正式“世界事实”结构；`EVENT` 消息和 `agent_memory(FACT)` 都不具备正史约束。本轮新增 `world_fact`。
2. 当前记忆主要是聊天/导入形成的自然语言条目；没有后置执行器，不能宣称已自动沉淀为决策约束。
3. 当前关系是摘要和自由 JSON；无法解释变化原因。本轮新增 append-only `relationship_change`，每条必须引用原因事实。
4. 当前 Prompt 允许角色卡替换默认系统提示，无法防止否认过去。本轮把结构化正史渲染在所有角色卡、关系、记忆和后置指令之后。
5. 原系统不区分事实、主观理解、临时情绪、关系原因和计划。本轮分别落在 `world_fact`、`character_knowledge`、`character_world_state`、`relationship_change` 中。
6. 前端被聊天页面结构绑死。此次不重构 UI，只把聊天降级为演出通道并复用 `EVENT`。
7. Provider、账号/套餐、地图、小手机、多角色和更多演出资源都是横向扩张，暂缓。

## 最小纵向验证切片

### 为什么是一个角色、两个世界线、两次后续决策和一次补救

角色数不是验证变量。多个角色会把“因果持续”与“多 Agent 社会模拟”混在一起。一个角色足以验证同一角色内核在不同历史下作出不同但合理的选择。

场景数量也不是目标。所需最小时间结构是：

1. 玩家完成一个有意义的承诺结果；
2. 系统记录正式事实和角色认知；
3. 后续同类决策第一次受影响；
4. 再次交互时影响仍存在；
5. 玩家执行补救；
6. 新决策可以变化，但原失约事实仍在。

测试使用两个独立玩家世界线：

- 兑现承诺：`reliability +2`，后续角色选择再次向玩家求助；
- 失约：`reliability -3`，连续两次后续决策都改为寻找别人；
- 补救：新增补救事实和 `reliability +4`，未来可恢复向玩家求助，原失约事实和关系变化仍可查询。

事件语义不在引擎中硬编码。内容层传入事实、有限状态变化和一个“关系维度达到阈值时选择 A，否则选择 B”的决策规则。引擎只执行、记录和引用。

## 本轮范围

### 保留

- 角色卡、会话、消息、多气泡、记忆、关系导入、Provider 与身份隔离；
- 现有短信 UI 作为第一种演出界面。

### 修改

- 每个 `user + character` 自动拥有一个 `world_instance`；
- 会话挂接 `world_id`；
- Context manifest 增加 `world_id/fact_ids/decision_ids`；
- Prompt 最末尾增加最高优先级正史块；
- README 主定位调整为 AI 角色世界。

### 新增

- append-only `world_fact`；
- `character_knowledge`；
- `character_world_state`；
- append-only `relationship_change`；
- `character_decision` 与 `character_decision_fact`；
- `recordWorldTransition` 和 `decideFromWorldState`；
- 决策结果写成现有聊天 `EVENT` 消息。

### 暂缓

- 自动事实抽取与确认 worker；
- 内容编排/事件作者工具；
- 地图、多 NPC、小手机、Galgame 资产和复杂日程；
- 通用游戏引擎、经济系统、市场、多人世界；
- 与因果闭环无关的 Provider、账号、套餐和后台扩展。

## 最小数据流

```text
内容/规则层确认玩家行为
  -> recordWorldTransition
  -> append world_fact
  -> append character_knowledge
  -> append relationship_change
  -> 更新 character_world_state 当前快照
  -> decideFromWorldState 读取有限状态
  -> 写 character_decision
  -> 写 character_decision_fact（决策引用了哪些正史）
  -> 写 chat_message(role=EVENT)
  -> 现有聊天 UI 展示后果
  -> assembleContext 将正史置于所有可变 Prompt 之后
```

权威层级：

```text
稳定角色内核 + 世界正史（append-only）
  > 已执行决策
  > 角色主观认知
  > 关系变化原因与当前关系维度
  > 临时情绪/目标
  > 尚未发生的计划
  > 聊天摘要、长期记忆、角色卡自定义指令
```

模型负责把已确定的状态演成自然语言。当前确定性内核决定结果，避免把模型随机输出误认为角色自主性。

## 数据库迁移

Migration v8：`causal_world_foundation`

- 新表：`world_instance`
- 新表：`world_fact`
- 新表：`character_knowledge`
- 新表：`character_world_state`
- 新表：`relationship_change`
- 新表：`character_decision`
- 新表：`character_decision_fact`
- 新列：`chat_conversation.world_id`
- 数据库 trigger：禁止 `UPDATE/DELETE world_fact`

已有数据库不会批量伪造历史事实。旧会话在下一次打开/创建时挂接世界线，旧消息和旧记忆继续保留，但不会被自动升级为正史。

## 商业验证路径

最可能形成付费动机的时刻不是“额度耗尽”，而是玩家已经看见自己的选择造成独有后果，并准备跨阶段继续这条不可替代的世界线时。

建议使用现有 `critical_action` 事件框架增加以下 `action_name`，不记录正文：

- `world_fact_committed`
- `causal_consequence_presented`
- `causal_consequence_revisited`
- `repair_path_started`
- `repair_path_completed`
- `world_continuation_paywall_viewed`
- `world_continuation_purchase_started`
- `world_continuation_purchase_completed`

属性只记录匿名业务 ID、世界线年龄、事实数桶、后果复现次数桶、路径类型和付费动机：

- `MODEL_USAGE`
- `CHARACTER_OR_IP`
- `WORLD_CONTINUATION`
- `NEW_WORLD_SPACE`
- `LIFE_STAGE_OR_EVENT_SPACE`

核心实验应比较普通聊天组与因果世界组的：

- 首次明确后果后的 D1/D7 回访；
- 同一世界线连续访问次数；
- 主动补救率；
- 后果再次出现后的继续率；
- `WORLD_CONTINUATION` 付费意愿，而不是只看消息额度购买。

## 当前不能宣称成立

1. 自由聊天尚不能自动、安全地升级为正式世界事实。
2. 后置任务没有执行器，记忆和摘要不会自动可靠更新。
3. Prompt 约束显著降低模型否认历史的空间，但还没有对模型自然语言输出做结构化矛盾检测和重试，因此不能宣称所有 Provider 都绝不会说出冲突文本。
4. 当前事实全部注入 Context；小切片可靠，长期扩展需要“不可丢失的正史索引 + 按决策相关性选择”的预算策略。
5. 账号合并遇到同一角色的两条既有世界线时，合并策略涉及数据生命周期与用户可见行为，尚未擅自决定。
6. 目前因果转换由内部可信调用触发，尚无内容生产或玩家选择 UI。

## 下一项最高优先级行动

实现“受信任的行为确认器”：从一次明确的结构化玩家选择产生候选事实，经过规则校验（必要时玩家确认）后调用 `recordWorldTransition`。随后把一次真实选择接入现有聊天页，做第一轮普通聊天 vs 因果世界的留存与继续意愿实验。
