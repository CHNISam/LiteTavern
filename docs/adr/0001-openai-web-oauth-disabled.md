# ADR-0001：v0.1.0 暂不开放 OpenAI Web OAuth

- 状态：已接受
- 日期：2026-07-24
- 适用版本：v0.1.0

## 背景

LiteTavern v0.1.0 是 Web/PWA 产品。OpenAI Provider 需要继续支持 API Key，同时评估是否可以让第三方 Web 应用通过 OpenAI/ChatGPT OAuth 获得模型调用权限，并消耗用户已有的 ChatGPT 套餐额度。

仓库中已有 `codex-device-code` 和 `codex-cli` 认证定义。它们面向 Codex 产品及 Codex App Server，不能据此推导出第三方 Web 应用拥有通用 OpenAI 模型 OAuth 权限。

## 官方能力核查

截至本 ADR 日期，公开官方资料能确认：

1. [Sign in with ChatGPT](https://learn.chatgpt.com/docs/sites#add-sign-in-with-chatgpt) 提供用户身份登录能力，但没有公开承诺向任意第三方 Web 应用授予通用模型 API 调用权限。
2. [Codex App Server](https://learn.chatgpt.com/docs/app-server) 的 ChatGPT 登录流程属于 Codex 产品集成范围，不能复用为 LiteTavern 的通用 OpenAI OAuth。
3. [OpenAI API Authentication](https://developers.openai.com/api/reference/overview#authentication) 公开的模型 API 调用方式仍以开发者平台凭证为准；公开资料没有给出满足本产品需求的第三方 Web OAuth Client 注册、模型调用 scope、审核流程和稳定授权契约。
4. [Codex pricing](https://learn.chatgpt.com/docs/pricing) 描述的是 Codex 与 ChatGPT 套餐之间的使用关系，不能证明任意第三方 Web 应用可以消耗用户的 ChatGPT 套餐额度。

因此，当前无法合法、稳定地实现“第三方 Web 应用使用 ChatGPT 账号授权后调用通用 OpenAI 模型并消耗 ChatGPT 套餐额度”。这是基于公开能力边界作出的保守结论，不代表身份登录能力不存在。

## 决策

v0.1.0 采用以下最小收口：

- `OPENAI_WEB_OAUTH_ENABLED` 固定为 `false`；
- Web 端不显示“使用 ChatGPT 账号连接”；
- OpenAI Provider 在 Web 端只提供 API Key、Base URL 和 Model ID 配置；
- `/v1/providers` 明确返回 `openai_web_oauth_enabled: false`，但不暴露 `codex-device-code`；
- `codex-device-code` 和 `codex-cli` 仅保留为 Codex 产品范围的内部定义，不视为通用 OpenAI OAuth；
- 产品免费体验额度继续走现有 `PLATFORM` 流程，不要求 OpenAI 登录。

本版本不实现 OAuth Token 数据表、回调、PKCE、Token 保存/刷新/撤销、Codex App Server 适配器或桌面端。

## 重新评估条件

仅当 OpenAI 官方同时公开并允许以下能力时，才重新评估开启入口：

1. 明确允许第三方 Web 应用获得模型调用授权；
2. 提供正式的 OAuth Client 注册、回调地址管理以及应用审核或白名单流程；
3. 公布可申请的 scope、可调用模型/API/产品范围和账户类型差异；
4. 明确调用消耗 ChatGPT 套餐额度还是独立 API 账单；
5. 提供适用于服务端 Web 应用的 Token 刷新、撤销、失效检测和安全存储要求；
6. 相关授权路径在正式文档和服务条款中稳定可用，而非 Codex 私有客户端身份或未公开接口。

满足这些条件后，需要另行进行产品、安全和数据模型评审；不得仅把本开关改为 `true` 就上线。
