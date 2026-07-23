---
date: 2026-07-22
topic: pomchat-v0-1-0
---

# PomChat v0.1.0

## What We're Building

实现一个响应式 Web/PWA 角色聊天产品：用户以匿名身份进入联系人列表，与角色进行流式对话，查看角色档案和共同记忆，导入导出 CCv2/CCv3 角色卡，并为不同角色选择模型 Provider。实现必须遵守 `docs/v0.1.0` 中冻结的模块边界、状态机、数据隔离和 Context 生命周期。

## Why This Approach

采用 npm workspaces、React/Vite 前端和 Fastify 模块化单体后端。开发和测试使用 PGlite 提供无需 Docker 的 PostgreSQL 语义；数据库访问封装在 Repository 中，避免领域层锁定具体实现。Model Gateway 使用统一接口，原生协议和 OpenAI-compatible 协议由适配器归一为同一流式事件与错误模型。

## Key Decisions

- 国内 Provider 为首发重点：DeepSeek、阿里百炼/Qwen、火山方舟/豆包、智谱 GLM、Kimi、MiniMax、硅基流动、百度千帆、腾讯混元和阶跃星辰。
- 同时支持 OpenAI、Anthropic、Google Gemini、OpenRouter、xAI、Mistral、Groq、Ollama、LM Studio 与自定义 OpenAI-compatible 端点。
- 每个常见 Provider 提供独立预设、默认端点、区域提示、连接验证、模型发现和人工模型 ID 回退，不把国内厂商隐藏在“自定义 URL”中。
- 用户自带的 BYOK API Key 仅保存在当前浏览器 IndexedDB；前端只显示掩码，不回显完整 Key。
- Provider 普通配置持久化在服务端，通过浏览器本地 `credential_id` 关联 Key；缺少本地凭证时明确显示待重新连接。
- 服务端仅在验证和 BYOK 模型生成过程中临时接收用户 Key，不持久化、不缓存、不写日志、错误或埋点。
- PomChat 官方额度使用服务端环境独立配置的 `PLATFORM_MANAGED` Provider 凭证；该凭证不存业务数据库、不返回前端，也不得与 BYOK 凭证互相回退或复用。
- 每次生成显式选择 `PLATFORM` 或 `BYOK`，两种模式使用独立 CredentialResolver、额度校验和 UsageLedger 路径。
- 暂不实现跨设备同步、云端托管、`POMCHAT_MASTER_KEY` 或 KMS。
- UI 延续原型的双栏、浅色内容面板和深色氛围背景，但不复制原型中的第三方游戏素材；使用 PomChat 自有图形和渐变头像。
- 高频聊天和键盘操作不添加阻塞动效；弹窗、抽屉和按压反馈使用 300ms 内的可中断过渡，并支持 reduced motion。

## Resolved Questions

- **Provider 是否可只做 Mock 或单一厂商？** 不可。必须提供多厂商且重点覆盖国内主要平台。
- **API Key 是否存服务端？** 不存。只在当前浏览器 IndexedDB 保存。
- **浏览器本地规则是否适用于 PomChat 官方额度？** 不适用。只约束用户 BYOK；官方 Provider 凭证由服务端独立配置。
- **两套凭证能否自动回退或混用？** 不能。调用模式、凭证和计费账本必须完全隔离。
- **是否为未来跨设备同步预建 KMS/云凭证系统？** 否，按 YAGNI 延后。

## Open Questions

- 无阻塞项。平台体验模型在 v0.1.0 使用明确标记的本地 Demo Provider，仅用于首次体验和自动化测试；真实对话由用户配置的 Provider 承担。

## Definition of Done

- 新用户可直接进入产品、选择角色并完成 Demo 对话。
- 用户可在引导式界面中连接至少一个国内 Provider，验证连接、选择模型、更新或删除本地 Key。
- 用户 BYOK Key 与平台官方凭证都不出现在数据库、API 响应、应用日志、错误信息、埋点或前端明文回显中。
- 平台额度与 BYOK 调用分别结算，任何请求都能从账本明确识别 `PLATFORM` 或 `BYOK`。
- 聊天、档案、记忆、角色设置、模型选择与模型服务配置形成完整可导航闭环。
- 核心状态、数据隔离、幂等、Provider 连接和 Key 生命周期有自动化测试。

## Next Steps

→ Execute `docs/plans/2026-07-22-feat-pomchat-v0-1-0-plan.md`.
