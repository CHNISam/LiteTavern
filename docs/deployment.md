# PomChat v0.1.0 部署维护

## 部署结构

- GitHub：`CHNISam/PomChat`，自动部署分支 `feature/cloudflare-deployment`
- Cloudflare Pages：`pomchat-v010`，生产地址 `https://pomchat-v010.pages.dev`
- Cloudflare Worker：`pomchat-gateway`，生产地址 `https://pomchat-gateway.1580811831.workers.dev`
- Render Web Service：`pomchat-api-v010`（Free），运行 Fastify/PGlite API

Render 免费实例会休眠，且本地文件系统在重启、重新部署或休眠恢复后可能重置。该限制仅适用于首次公开测试版。

## 构建和发布

Cloudflare Pages：

```text
根目录：/
构建命令：npm ci && npm run build --workspace @pomchat/web
输出目录：apps/web/dist
Node.js：22.22.0
```

Worker：

```text
根目录：/
构建命令：npm ci && npm run build --workspace @pomchat/worker
部署命令：npx wrangler deploy --config wrangler.jsonc
```

Render：

```text
构建命令：npm ci && npm run build
启动命令：npm run start --workspace @pomchat/api
健康检查：/health
```

## 环境变量与 Secret

Pages 普通变量：

- `NODE_VERSION=22.22.0`
- `POMCHAT_GATEWAY_ORIGIN`：Worker 的 HTTPS 地址；若已配置 `POMCHAT_GATEWAY` Service Binding，可省略

Worker 普通变量：

- `BACKEND_ORIGIN`：Render API 地址
- `POMCHAT_WEB_ORIGIN`：Pages 生产地址

Worker Secrets：

- `POMCHAT_MODEL_PROXY_TOKEN`：Worker 与 API 之间的共享随机令牌
- `POMCHAT_PLATFORM_API_KEY`：官方 Provider Key；当前未配置，官方额度入口保持关闭

Render 普通变量：

- `NODE_VERSION`、`NODE_ENV`、`HOST`
- `POMCHAT_DATA_DIR`、`POMCHAT_ASSET_DIR`
- `POMCHAT_WEB_ORIGIN`
- `POMCHAT_MODEL_PROXY_URL`
- `POMCHAT_PLATFORM_ENABLED=false`

Render Secret：

- `POMCHAT_MODEL_PROXY_TOKEN`：必须与 Worker 中的同名 Secret 一致

不得创建任何 `VITE_*` Provider Key。用户自带 Key 只存于浏览器 IndexedDB。

## 本地开发

```bash
npm ci
npm run dev
```

默认本地 API 直接连接 Provider。需要联调模型代理时，同时设置
`POMCHAT_MODEL_PROXY_URL` 与 `POMCHAT_MODEL_PROXY_TOKEN`。

## 自动部署与回滚

GitHub 分支 `feature/cloudflare-deployment` 的后续推送会触发 Pages、Worker 和 Render 自动部署。

需要从本地手动重新发布 Worker 时：

```bash
npm run deploy:worker
```

- Pages：在项目 Deployments 中选择上一条成功部署并执行回滚
- Worker：在 Workers & Pages 的 Deployments 中选择上一版本并回滚
- Render：在 Deploys 中选择上一成功提交并重新部署

回滚前不要删除当前版本，先保留可恢复的成功部署。

## 常见故障

- 首页可开但 `/v1/*` 返回 503：检查 Pages 的 Service Binding 或 `POMCHAT_GATEWAY_ORIGIN`
- Worker 返回 502/连接失败：检查 `BACKEND_ORIGIN` 和 Render 是否正在冷启动
- API 启动失败：确认两个 `POMCHAT_MODEL_PROXY_*` 变量同时存在
- 浏览器请求被拒绝：确认 Worker 与 Render 的 `POMCHAT_WEB_ORIGIN` 与实际 Pages Origin 完全一致
- 官方额度提示未配置：这是当前预期状态；配置 Worker Secret 后，还需设置 Provider、模型与 `POMCHAT_PLATFORM_ENABLED=true`
- Render 数据消失：免费实例临时文件系统的已知限制，不是可恢复持久存储
