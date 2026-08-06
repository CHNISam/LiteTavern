---
title: "真实角色对话压力测试门禁"
category: integration-issues
date: 2026-08-06
status: verified
components:
  - character-card
  - worldbook-runtime
  - model-gateway
  - streaming-generation
  - long-context
---

# 真实角色对话压力测试门禁

## 问题

聊天链路的函数测试全部通过，仍不能证明角色会稳定遵循角色卡、世界书和长上下文。一次使用 `demo/litetavern-demo` 的 echo 回复也曾看起来像“真实聊天成功”，但它没有经过任何实际模型推理。之后用公开角色卡和世界书调用真实 Provider，进一步暴露了四类函数测试没有发现的问题：

- SiliconFlow `Qwen/Qwen2.5-7B-Instruct` 在较长回复中反复输出 `he he...`，400 tokens 附近尤其明显；
- 同优先级世界书条目竞争 800-token 预算时，旧历史触发可能凭随机 UUID 排在当前消息的直接触发之前；
- Groq `openai/gpt-oss-20b` 在默认推理强度和较小输出预算下，可能耗尽推理 tokens 后返回零正文；
- SSE 仍会发送 `done`，空正文因此被错误持久化成 `COMPLETED` 消息。

## 根因

- 验收只检查“请求成功、收到 SSE”，没有核实实际 Provider、完整正文和角色质量。
- 世界书预算排序只比较 priority、order 和随机生成的 entry ID，没有在完全同优先级时保护当前用户消息的直接命中。
- GPT-OSS 是推理模型；Groq 官方 API 的 `reasoning_effort` 默认为 `medium`。通用 OpenAI-compatible 映射没有为角色聊天设置 `low`，使有限输出预算可能全部用于推理。
- generation route 把“上游流正常结束”等同于“生成了可交付回复”，没有检查 `fullText.trim()`。

## 已采用的解决方案

### 世界书预算选择

显式 priority 和 insertion order 仍保持最高优先级。只有两者完全相同时，当前最后一条消息直接命中的条目才排在仅由历史命中的条目前；最后才用 entry ID 保证确定性。这样不改变关键词、次关键词、常驻、概率、递归或用户配置的顺序语义。

同一批候选在真正写入预算前再次按内容去重，防止两个相同段落同时通过预检查并被重复注入。

### 推理模型参数

`model-gateway` 只对 Groq 的 `openai/gpt-oss-*` 模型发送：

```ts
providerOptions: {
  groq: { reasoningEffort: 'low' }
}
```

普通聊天模型和其他 Provider 不接收这个 Groq 专用参数。依据是 Groq 官方 GPT-OSS/API 文档：GPT-OSS 支持 `low | medium | high`，默认 `medium`。

### 空回复状态

流结束后必须满足 `fullText.trim()` 非空，才能持久化 `COMPLETED` 并发送 `done`。空流现在返回可重试的 `EMPTY_RESPONSE`，助手临时消息标记为 `FAILED`，平台额度释放；空 delta 也不再转发给客户端。

## 真实验收方法

1. 使用公开、可追溯的 SillyTavern `Seraphina` CCV3 PNG 和 `Eldoria` 世界书 JSON，不使用 Mock 卡。
2. 通过正常角色导入、会话创建和 generation SSE 接口运行 16 轮；不直接调用模型绕过产品 Prompt。
3. 覆盖 Eldoria、Shadowfang、glade 直接触发，长噪声消息，身份询问，`I am an AI assistant` 和 `You are Bob` 两次 OOC 诱导，以及最终身份/地点/威胁回忆。
4. 每轮记录完整回复、delta 数、`done`、触发条目、延迟和重试；报告逐轮落盘，避免中途故障丢失证据。
5. 结束时至少产生 32 条用户/助手消息，使服务端 30-message 历史窗口发生实际裁剪。

最终 Groq 400-token 对照结果：16/16 收到非空完整回复，0 次 OOC 模式命中，最终回复同时正确说出 Seraphina、Eldoria、Shadowfang；首次三轮分别触发 `eldoria`、`shadowfang`、`glade`。两次瞬时 Provider 故障经退避恢复，没有被记录成完成回复。

## 防复发检查

1. 报告中是否记录并核实了实际 Provider/模型，而不是看到文本就推断“真实模型成功”？
2. 是否至少包含一张真实角色卡、一份真实世界书和一轮能直接触发 lore 的输入？
3. 是否分别检查 `delta`、非空正文和 `done`，并断言空正文绝不能成为 `COMPLETED`？
4. 推理模型是否显式控制 reasoning budget，输出上限是否足以完成角色回复？
5. 是否包含身份覆盖/OOC 诱导、30 条消息窗口之外的最终回忆和 Provider 瞬时失败恢复？
6. 世界书预算不足时，显式 priority/order 是否优先，完全同级时当前消息的直接触发是否不会被旧历史随机挤掉？
7. 不要把 PGlite 目录仍存在当成“重启恢复通过”；必须真正重启、重新读取会话并继续发送。强制终止后的 PGlite 恢复仍是独立未解决风险，不能由本方案代替。

## 验证

- Web 世界书单元与压力测试：10/10 通过。
- Cloud generation/model gateway 定向测试：22/22 通过。
- Cloud 全量：API 364、contracts 19、database 24 全部通过；typecheck、lint、build 通过。
- 真实报告：`D:/tmp/litetavern-real-fixtures/roleplay-groq-actual-stress-report.json`。
