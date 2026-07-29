# LiteTavern

LiteTavern 是一个可持续演化的 AI 角色世界：玩家的行为会成为世界历史，角色必须带着这些已经发生的事实继续生活。

产品的核心单位不是聊天框，而是：

```text
世界 + 角色 + 玩家行为 + 持续历史 + 因果后果 + 后续演出
```

聊天、短信、Galgame 场景、相册、日记、地图等只是同一世界状态的不同演出界面。最高级别原则是：

> AI 可以演绎历史，但不能随意改写已经发生的历史。
> 世界必须记住玩家做过什么，角色必须带着这些事实继续生活。

仓库中的历史包名和部分文档仍使用 `LiteTavern`；它们会在不破坏兼容性的前提下逐步迁移。现成 IP 仅可用于非商业原型验证，世界、事件和状态模型不得绑定任何外部 IP。

## 当前状态

v0.1.0 正在从“AI 角色聊天应用”转向“AI 角色世界”的最小纵向验证。当前界面仍以短信聊天为主，尚不能宣称完整因果闭环已在生产体验中成立。

当前实现包括：

- 基于项目原创原型、高度还原《崩坏：星穹铁道》官方短信视觉体验的响应式 Web / PWA 界面；
- Character Card V2 / V3 的 JSON、PNG 导入与导出；
- 基于角色卡、近期对话和角色记忆的流式对话；
- append-only 世界正史、角色主观认知、角色当前状态、可追溯关系变化和决策引用的最小数据基础；
- 可配置的确定性因果决策内核，以及复用聊天 `EVENT` 消息的后果演出；
- LiteTavern Cloud 平台额度与用户自带 API Key 两套完全隔离的调用路径；
- LiteTavern Cloud Alpha 测试程序：匿名 Trial、注册后进入候补、按批次动态放行、
  周期额度与真实成本账本、运营接口、导出与可验证的备份恢复；
- 国内、国际、本地与自定义 OpenAI-compatible Provider；
- 匿名身份、会话隔离、用量账本和增量自动化测试。

## 项目原则

- 优先打磨少量角色，不追求大量浅层内容。
- 优先验证“不同玩家行为能否形成长期不同、但角色内核一致的未来”，再横向扩展界面和内容。
- 正式世界事实只能通过新增事实补救或修正，不能被摘要、Prompt 或聊天编辑覆盖。
- 角色决策与演出界面分离；模型负责演绎，不负责决定正史是否存在。
- 尽量减少模型、提示词和角色设定等前置配置。
- 角色卡、头像和本地图片由用户自行准备并确认使用权。
- 应用与发布包不内置、不重新分发官方游戏图片、立绘、音频等资源。
- 项目原创代码、原创设计与用户本地导入内容必须明确区分。

本项目的四张 v0.1.0 页面原型均为项目原创设计资产，也是界面实现基准。

## API Key 安全边界

用户自带 API Key 仅保存在当前浏览器，优先使用 IndexedDB。前端只显示掩码，服务端仅在验证和模型请求期间临时接收并转发 Key，不持久化、不缓存，也不写入日志、错误信息或埋点。

LiteTavern Cloud 的平台额度使用服务端独立配置的官方 Provider 凭证。官方凭证、用户凭证与计费逻辑完全隔离。

## LiteTavern 与 LiteTavern Cloud

```text
LiteTavern        开源客户端、本地能力、角色聊天体验、BYOK、导入导出
LiteTavern Cloud  官方闭源账号、平台模型额度、Model Gateway、云同步、
                  云备份与恢复、用量成本、反滥用
```

客户端可独立构建为静态 Web / PWA，部署到 Cloudflare Pages、GitHub Pages、自定义域名或子路径，
通过 `VITE_CLOUD_BASE_URL`（构建时）或 `public/litetavern-config.js`（构建后可编辑）连接 Cloud，
不要求前后端同域，也不内置任何平台 API Key。Cloud 不可用时，本地角色、已缓存会话和 BYOK 仍可使用。

托管服务当前处于 **LiteTavern Cloud Alpha** 测试阶段：匿名访客获得一次性 Trial 额度；
注册后进入 Alpha 候补名单；只有被按批次放行后才获得 Alpha 平台额度。Alpha、Beta 表示测试阶段，
不是并列的价格套餐，本阶段不提供 Free / Pro 商业套餐。

## 支持 LiteTavern

LiteTavern 的开源部分可以免费使用。

如果项目对你有帮助，可以自愿支持服务器、模型调用、域名及持续开发成本：

[支持 LiteTavern](https://litetavern.pages.dev/support?source=github)

支持完全自愿，不影响任何功能使用。

支持页的微信二维码、爱发电、B 站和抖音入口均通过公开环境变量配置；仓库不保存真实二维码或私人账号信息。详见 [`.env.example`](./.env.example)。

## 本地开发

要求 Node.js 22 或更高版本。

```powershell
npm.cmd install
npm.cmd run dev
```

默认地址：`http://127.0.0.1:5173`

本仓库只包含开源客户端。托管服务已迁出到 LiteTavern Cloud 私有仓库，客户端通过
`VITE_CLOUD_BASE_URL` 以 HTTP 访问它，不共享任何构建依赖。开发时若需要本地后端，
请在 LiteTavern Cloud 仓库中运行 `npm run dev`（`http://127.0.0.1:3000`），
Vite 的 `/v1` 代理会自动转发过去。客户端也可以完全脱离 Cloud 单独运行。

运行完整检查：

```powershell
npm.cmd run check
```

## 仓库结构

```text
apps/
  web/          React / Vite 响应式 Web 与 PWA（本仓库的全部代码）
docs/
  project/      项目定位、宣传主文档与对外关系说明
  v0.1.0/       当前版本产品、原型和架构文档
```

## 文档

- [文档索引](./docs/README.md)
- [项目定位与宣传主文档](./docs/project/崩坏：星穹铁道短信AI项目.docx)
- [v0.1.0 产品流程](./docs/v0.1.0/product/交互流程图和页面流程图/readme.md)
- [v0.1.0 系统设计](./docs/v0.1.0/architecture/readme.md)

## 素材与许可证

本仓库的 GPL-3.0 许可证仅适用于项目原创代码、原创设计和原创素材。用户本地导入的角色卡、图片及其他内容不属于本仓库发布内容。

详见 [LICENSE](./LICENSE)。

## 服务端配置

平台额度、官方 Provider 凭证、埋点与成本账本都属于托管服务，已随 `apps/api`
迁出到 LiteTavern Cloud 私有仓库，相应的架构文档也在那里。本仓库的
[`.env.example`](./.env.example) 只包含构建时注入客户端的公开变量。
