---
title: "feat: Implement LiteTavern v0.1.0"
type: feat
status: active
date: 2026-07-22
origin: docs/brainstorms/2026-07-22-litetavern-v0-1-0-brainstorm.md
---

# Implement LiteTavern v0.1.0

## Overview

从零实现 `docs/v0.1.0` 规定的响应式角色聊天产品，覆盖匿名身份、联系人与会话、流式生成、Agent Context、记忆连续性、角色卡兼容、多 Provider BYOK 和原型页面闭环。实现以模块化单体为边界，不引入微服务、消息队列或云端凭证系统。

## Technical Approach

### Workspace

- `apps/web`：React、Vite、React Router、原生 IndexedDB credential vault、PWA。
- `apps/api`：Fastify、模块化 route/service/repository、SSE、Provider Gateway。
- `packages/contracts`：API DTO、状态、Provider registry 和错误码。
- `packages/database`：PostgreSQL migration、PGlite 开发/测试连接和 Repository 基础设施。

### Provider Gateway

- 使用统一 `ModelProviderAdapter` 接口暴露 `validate`、`listModels` 和 `streamText`。
- OpenAI-compatible adapter 覆盖国内兼容厂商与自定义端点；Anthropic、Gemini 等使用原生适配器。
- Provider preset 只保存公开元数据：名称、区域、Base URL、帮助链接、能力和兼容差异。
- 模型列表端点不可用时允许人工输入模型 ID，并通过一次最小请求验证。
- 将厂商错误归一为架构文档错误码；仅对明确可重试错误使用有限指数退避。

### Credential Boundary

- IndexedDB `litetavern-credentials` 保存 `{credential_id, provider, key, masked_hint, updated_at}`。
- 服务端 model configuration 只保存 `credential_id` 和 `credential_configured`，不保存 Key 或掩码来源以外的秘密。
- BYOK 验证与生成请求通过专用请求字段临时传 Key；Fastify logger 禁止记录 body/header，错误归一前移除 Provider 原始响应中的敏感内容。
- 更新 Key 保持 `credential_id` 稳定；删除后 UI 立即将相关配置标记为断开。
- `PLATFORM_MANAGED` 凭证只从服务端环境配置解析，不进入数据库、前端或 BYOK 接口。
- 生成请求显式携带 `usage_mode`，`PLATFORM` 与 `BYOK` 使用分离的 resolver、额度校验和账本结算，禁止隐式回退。

## System-Wide Impact

### Interaction Graph

`send message → identity authorization → conversation lock/idempotency → context assembly → credential lookup in browser → Model Gateway → SSE → message checkpoint/finalize → postprocess job → memory/summary update`。

### Failure Propagation

- 身份/资源错误在调用 Provider 前失败，不创建外部调用。
- Provider 失败保留用户消息与助手占位状态，返回归一化、无敏感信息的错误。
- SSE 断开不等同取消；显式取消才推进取消状态机。
- 后置任务失败重试但不回滚已完成回复。

### State Lifecycle Risks

- 用 `user_id + idempotency_key` 阻止重复消息和用量。
- 新回复成功前不替换旧 active variant。
- Credential 删除不删除普通 Provider 配置，只使连接失效。
- 平台额度不足只返回平台额度错误，不得尝试用户 BYOK；BYOK 缺少 Key 也不得消耗平台额度。
- 记忆删除和替代必须立即停止召回旧版本。

## Implementation Phases

### Phase 1 — Foundation

- [ ] 创建 npm workspace、TypeScript、lint、test、build 和开发脚本。
- [ ] 创建共享契约、统一错误码、Provider registry 与配置 schema。
- [ ] 创建 PostgreSQL migration 和 PGlite 连接，覆盖架构文档核心数据表与约束。
- [ ] 实现匿名身份 Cookie、授权中间件与 Repository 用户作用域。

### Phase 2 — Core API and Chat Runtime

- [ ] 先写身份隔离、会话、消息幂等和生成状态测试。
- [ ] 实现角色、会话、消息、关系与记忆 API。
- [ ] 实现 Prompt Sections、Token Budget、Context Manifest 和近期消息装配。
- [ ] 实现 SSE 生成、检查点、取消、重试和 active variant 规则。
- [ ] 实现数据库驱动后置任务、摘要和确定性记忆提取基线。

### Phase 3 — Multi-Provider BYOK

- [ ] 先写 Provider registry、错误归一、临时 Key 和日志泄露安全测试。
- [ ] 先写平台凭证/BYOK 凭证隔离、额度隔离与禁止自动回退测试。
- [ ] 实现国内十家 Provider 预设及 OpenAI-compatible adapter。
- [ ] 实现 OpenAI、Anthropic、Gemini、OpenRouter、xAI、Mistral、Groq、Ollama、LM Studio 和自定义端点。
- [ ] 实现连接验证、模型发现、人工模型回退与流式归一。
- [ ] 实现 Provider configuration API，保证数据库不包含 Key。

### Phase 4 — Product UI

- [ ] 建立 LiteTavern 设计 tokens、响应式 shell、联系人列表和移动端导航。
- [ ] 实现产品介绍/匿名进入、角色聊天与流式状态恢复。
- [ ] 实现角色档案、记忆管理和删除确认。
- [ ] 实现角色设置、模型选择和模型服务连接向导。
- [ ] 实现 IndexedDB credential vault、掩码、验证、更新和删除流程。
- [ ] 实现空状态、错误状态、键盘操作、reduced motion 和基础无障碍。

### Phase 5 — Character Cards and Continuity

- [ ] 先写 CCv2/CCv3 JSON/PNG、未知字段、损坏文件和 10MB 限制测试。
- [ ] 实现 JSON/PNG 检测、解析、标准化、版本化导入和导出。
- [ ] 实现记忆修正、隔离、摘要阈值和 Context 回归测试。
- [ ] 实现核心埋点，确保正文与 Key 不进入 properties。

### Phase 6 — Verification and Polish

- [ ] 运行新增/修改测试、相关模块测试和全量测试。
- [ ] 运行 lint、类型检查和生产构建。
- [ ] 启动应用，完成联系人→聊天→档案→记忆→设置→Provider 的浏览器 E2E。
- [ ] 对照四张原型截图进行桌面与移动端视觉检查并修正关键差异。
- [ ] 更新 README、环境变量示例、运行方式和已知限制。

## Acceptance Criteria

### Functional

- [ ] 匿名用户能恢复自己的会话，且无法访问其他身份的数据。
- [ ] 联系人、聊天、档案、记忆、角色设置、模型选择和 Provider 配置可完整导航。
- [ ] 生成支持 SSE、幂等、检查点、取消与失败重试。
- [ ] 国内主要 Provider 均有独立预设，用户无需理解协议即可连接。
- [ ] 支持验证、更新和删除浏览器本地 Key，删除后不可继续调用。
- [ ] 支持 CCv2/CCv3 JSON 与 PNG 导入导出并保留未知字段。

### Security and Privacy

- [ ] 数据库、日志、错误、响应与埋点中不存在完整 API Key。
- [ ] 用户 BYOK Key 只位于当前浏览器 IndexedDB，并只在实际请求期间到达服务端。
- [ ] 平台官方凭证只从服务端环境读取；两种凭证和计费路径完全隔离。
- [ ] 所有用户数据访问包含 `user_id` 作用域。
- [ ] 角色卡被当作不可信输入，不执行脚本、不请求远程 URL、不信任文件扩展名。

### Quality

- [ ] 单元、API 集成、状态、数据、安全与核心 E2E 测试通过。
- [ ] TypeScript 严格类型、lint 和生产构建通过。
- [ ] UI 在桌面和移动宽度可用，键盘可达并支持 reduced motion。

## ADR Defaults

- ADR-001：浏览器 IndexedDB 本地凭证，已由用户确认。
- ADR-001 补充：该决策仅适用于 BYOK；平台官方凭证采用服务端环境配置，且与 BYOK 完全隔离。
- ADR-002：首版关键词、主题、重要性和时间评分；接口可替换。
- ADR-003：10K/5K 起始阈值，配置化。
- ADR-004：PGlite 作为开发/测试 PostgreSQL；Repository 隔离生产连接。

## Sources

- [Product flows](../v0.1.0/product/交互流程图和页面流程图/readme.md)
- [Architecture baseline](../v0.1.0/architecture/readme.md)
- [Origin brainstorm](../brainstorms/2026-07-22-litetavern-v0-1-0-brainstorm.md)
- [Vercel AI SDK providers](https://ai-sdk.dev/providers/openai-compatible-providers/custom-providers)
- [Fastify v5](https://fastify.dev/docs/latest/)
- [PGlite](https://pglite.dev/docs/api)
- [Character Card V3 specification](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md)
- [SillyTavern](https://github.com/SillyTavern/SillyTavern)
