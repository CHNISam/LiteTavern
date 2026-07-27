# Agent 多气泡发言机制 v0.1.0

> 定稿日期：2026-07-24。目标是还原《崩坏：星穹铁道》短信的表现形式——用户发一条，Agent
> 一次生成一个「可分段、可中断的短发言回合」，回合内含 1～4 个气泡，由程序按固定节奏逐条展示。

## 一、第一性原理

- **模型负责语义**：这一轮说什么、分成几个气泡、每个气泡内容、气泡间顺序。
- **程序负责表现**：发送间隔、"正在输入"时长、逐条展示、自动滚动、中断取消、最大气泡数、异常降级。
- **模型不得输出**：`delay` / `interval` / `pace` / `wait_after` / `continue_probability` / `can_auto_continue`。
  这些是确定性的表现层规则，让模型参与只增加 Token 与不稳定性。

## 二、模型输出协议（v0.1.0 仅文本）

```json
{ "messages": ["等等。", "你刚才说的是真的吗？", "……算了，当我没问。"] }
```

约束：数量 1～4；单条非空；默认优先 1～2 条，仅语义/情绪确需时才 3～4 条；按**语义节拍**拆分，
禁止机械按标点切句；禁止为多气泡而拆句；禁止数组外输出解释。降级：非法 JSON → 单气泡（原始文本）；
超 4 条 → 前 3 条 + 其余合并进第 4 条；空数组 → 视为生成失败，不建空白气泡。

## 三、固定时间参数

以 `blacktunes/sr-message-maker` 的节奏为基线：

```ts
const TURN_START_DELAY_MS = 1000
const MESSAGE_INTERVAL_MS = 1500
const TYPING_MS_PER_CHAR = 50
const MIN_TYPING_MS = 1000
const MAX_TYPING_MS = 3000
const MAX_MESSAGES_PER_TURN = 4

function calculateTypingDuration(content: string): number {
  return Math.min(Math.max(content.length * TYPING_MS_PER_CHAR, MIN_TYPING_MS), MAX_TYPING_MS)
}
```

**API 延迟并入首条**：最低首条展示时间 = `TURN_START_DELAY_MS + 第一条输入动画时间`；实际额外等待
= `max(最低首条时间 − API 已耗时, 0)`。若 API 已耗时超过该阈值，结果返回后立即展示第一条，不叠加等待。
后续气泡：上一条展示完成 → 等 1500ms → 显示正在输入 → 等 1000～3000ms → 展示下一条。

参考实现同为确定性调度：`cubeww/star-rail-msg-maker` 从剧情节点读 `time`，对方消息用 `time×1000`
作输入时间，完成后再等约 600ms 执行下一节点。两套的共同原则都是**程序/剧情控制时间，而非模型控制时间**。

## 四、运行状态机

```text
IDLE → 用户发送 → GENERATING → 模型返回 → (TYPING → DISPLAYING → WAITING_INTERVAL)* → IDLE
```

**中断规则**：用户**发送**新消息（不是开始输入）时，无论处于哪个状态，都执行
`abortCurrentRequest → clearAllTimers → hideTyping → discardPendingMessages → startNewTurn`；
已展示的气泡保留，未展示的丢弃。不以"开始输入/键盘输入"为中断条件（避免误删）。

**并发安全**：每次 `startTurn` 递增 `activeTurnVersion`，每个异步续作执行前校验版本，防止旧请求晚返回覆盖新回合。

**后台**：页面进入后台暂停计时，恢复时从当前节点继续，不一次性倾泻积压消息。

## 五、存储：展示一条写一条

模型返回的数组只是**临时发言计划**，不立即全部落库。每条气泡在**前端展示的那一刻**写入正式消息记录
（带 `turn_id` / `sequence_no`）；被中断而未展示的气泡不入库。v0.1.0 不持久化未发送队列，刷新/切换会话/退出即丢弃。

## 六、成本

一次用户发送只触发 **1 次模型调用**，生成完整短回合；程序播放 N 个气泡不额外调用模型，也无"是否继续发送"决策请求。

## 七、验收标准

1. 返回一条 → 只显示一个气泡。2. 返回三条 → 按固定节奏逐条展示。3. 每条展示前都有输入状态。
4. 用户在第一条后发送 → 第二三条不再出现。5. 被取消的消息不写库。6. 旧请求晚返回不覆盖新回合。
7. 非法 JSON 降级单气泡。8. 超四条正确合并。9. 后台不一次性倾泻。10. 整回合只一次模型调用。

## 八、v0.1.0 不做

每气泡重新调用模型；模型决定延迟/输出 wait·send 动作；无限连续发言；每角色独立速度；主动定时联系；
离线调度；跨设备恢复未发送队列；按用户是否打字决定是否继续；自动按标点切分；复杂工作流/独立 Agent 编排。

## 九、许可

`cubeww/star-rail-msg-maker` 为 MIT，直接复用其代码须保留版权与许可声明；`blacktunes/sr-message-maker`
在直接复制代码前需单独确认许可证。**本实现只借鉴参数与交互规律，未复制其代码。**

---

## 十、实现状态（2026-07-24）

已交付（后端 + 播放内核，全部测试通过）：

- `apps/web/src/lib/turn-playback.ts` — `TurnPlaybackController`：可注入时钟的状态机，含固定节奏、
  首条并入 API 耗时、版本隔离、pause/resume、`parseTurnPlan` 降级、`normalizeMessages` 合并。
  `turn-playback.test.ts` 13 项，逐条覆盖验收 1–10。
- `packages/database` migration v4 `multi_bubble_turns`：解绑 `chat_message.generation_request_id`
  的 1:1 UNIQUE，新增 `turn_bubble_no` 与 `(generation_request_id, turn_bubble_no)` 幂等唯一索引，
  DROP `idx_one_active_assistant_variant`（一回合多条 active assistant）。
- `packages/contracts` `turnBubbleSchema`（message_id / text / bubble_no）。
- `apps/api` `POST /v1/conversations/:id/turns`（生成整回合，一次模型调用，凭证隔离 + 配额 + 编辑分支
  supersede + 空计划失败回滚 + 幂等重放）与 `POST /v1/conversations/:id/turns/:turnId/bubbles`
  （逐条落库，客户端 message_id 幂等）。`turn.test.ts` 8 项。

待接线（前端聊天页）：

- `apps/web/src/App.tsx` 的发送流程改为：调用 `/turns` 拿 `{turn_id, messages}` → 交给
  `TurnPlaybackController` 播放 → `onBubble` 时乐观插入气泡并 `POST /bubbles` 落库 → `onTypingChange`
  控制"正在输入"气泡 → 用户再次发送即 `startTurn` 中断旧回合 → `visibilitychange` 驱动 pause/resume。
- 更新 `App.test.tsx` 相关用例适配 `/turns` + `/bubbles`（原 `/generations` SSE mock 改造）。

> 注意：接线时 `App.tsx` 与角色卡编辑（CharacterEditor）等改动可能并行存在，需先协调分支归属，避免互相覆盖未提交改动。
