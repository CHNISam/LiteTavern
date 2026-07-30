# LiteTavern 管理后台 v0.1.0

`/admin` 与用户端共用 Pages 构建，但后台代码通过 `React.lazy` 单独加载。路由
本身不构成授权：所有数据和写操作都调用 LiteTavern Cloud 的
`/api/admin/*`，并由服务端再次验证管理员身份。

## 本地访问

```powershell
$env:VITE_CLOUD_BASE_URL='http://127.0.0.1:3000'
npm run dev
```

访问 `http://127.0.0.1:5173/admin`，输入 Cloud 服务配置的
`CLOUD_ADMIN_TOKEN`。令牌只保存在页面内存中，刷新或关闭页面后需要重新输入。

用户端右下角提供极简反馈入口，提交到 `/v1/feedback`，包含页面、版本、
浏览器/设备、Provider/模型和可用 Trace；不包含完整聊天正文或 API Key。

Cloudflare Pages 仍按 `docs/release-governance.md` 使用独立 staging /
production 项目和 Access 边界。生产发布开关与人工审批规则没有改变。
