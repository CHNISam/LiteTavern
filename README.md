# LiteTavern

如果《崩坏：星穹铁道》的短信由 AI 驱动，会发生什么？

LiteTavern 是个人兴趣驱动的非官方同人开源项目。它尝试让角色根据性格、共同经历和玩家回应，继续发展属于玩家自己的故事。

> 本项目与米哈游、HoYoverse 及其关联方不存在隶属、合作、授权或官方背书关系。《崩坏：星穹铁道》相关名称、角色、世界观及其他内容的权利归相应权利人所有。

## 当前状态

v0.1.0 正在开发。首个体验角色方向为流萤，具体角色卡由用户本地导入，不随应用或仓库分发。

当前实现包括：

- 基于项目原创原型、高度还原《崩坏：星穹铁道》官方短信视觉体验的响应式 Web / PWA 界面；
- Character Card V2 / V3 的 JSON、PNG 导入与导出；
- 基于角色卡、近期对话和角色记忆的流式对话；
- LiteTavern 官方额度与用户自带 API Key 两套完全隔离的调用路径；
- 国内、国际、本地与自定义 OpenAI-compatible Provider；
- 匿名身份、会话隔离、用量账本和增量自动化测试。

## 项目原则

- 优先打磨少量角色，不追求大量浅层内容。
- 尽量减少模型、提示词和角色设定等前置配置。
- 角色卡、头像和本地图片由用户自行准备并确认使用权。
- 应用与发布包不内置、不重新分发官方游戏图片、立绘、音频等资源。
- 项目原创代码、原创设计与用户本地导入内容必须明确区分。

本项目的四张 v0.1.0 页面原型均为项目原创设计资产，也是界面实现基准。

## API Key 安全边界

用户自带 API Key 仅保存在当前浏览器，优先使用 IndexedDB。前端只显示掩码，服务端仅在验证和模型请求期间临时接收并转发 Key，不持久化、不缓存，也不写入日志、错误信息或埋点。

LiteTavern 官方额度使用服务端独立配置的官方 Provider 凭证。官方凭证、用户凭证与计费逻辑完全隔离。

## 本地开发

要求 Node.js 22 或更高版本。

```powershell
npm.cmd install
npm.cmd run dev
```

默认地址：

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:3000`

运行完整检查：

```powershell
npm.cmd run check
```

## 仓库结构

```text
apps/
  api/          Fastify 业务 API、Agent Runtime 与 Provider Gateway
  web/          React / Vite 响应式 Web 与 PWA
packages/
  contracts/    跨端契约、Provider 注册表与校验规则
  database/     PGlite 数据库、迁移和持久化边界
docs/
  project/      项目定位、宣传主文档与对外关系说明
  v0.1.0/       当前版本产品、原型和架构文档
```

## 文档

- [文档索引](./docs/README.md)
- [发布与环境治理](./docs/release-governance.md)
- [项目定位与宣传主文档](./docs/project/崩坏：星穹铁道短信AI项目.docx)
- [v0.1.0 产品流程](./docs/v0.1.0/product/交互流程图和页面流程图/readme.md)
- [v0.1.0 系统设计](./docs/v0.1.0/architecture/readme.md)

## 素材与许可证

本仓库的 GPL-3.0 许可证仅适用于项目原创代码、原创设计和原创素材。用户本地导入的角色卡、图片及其他内容不属于本仓库发布内容。

详见 [LICENSE](./LICENSE)。

## 官方免费回复与产品分析

复制 [`.env.example`](./.env.example) 为本地环境文件，并在服务端配置 Groq 和
Cloudflare Workers AI 凭证；浏览器不会接收这些 Secret。

- [官方免费额度实现与本地配置](./docs/v0.1.0/architecture/official-free-quota.md)
- [埋点字典与指标定义](./docs/v0.1.0/architecture/analytics-event-dictionary.md)
