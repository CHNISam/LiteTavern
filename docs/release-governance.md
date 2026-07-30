# LiteTavern 发布与环境治理

本规范用于防止未经验证的代码、错误命名的站点和本地临时构建进入生产。它适用于所有开发者、Agent、GitHub Actions 和 Cloudflare Pages 操作。

## 当前安全状态

- `main` 视为生产分支，但在首个合规稳定 Release 前不代表已有可发布产品。
- 现有 `litetavern.pages.dev` 手工上传内容属于历史临时预览，不据此补打标签、创建 Release 或宣称生产已发布。
- 历史 Git 集成 Pages 项目已删除，后续 Git push 不再旁路触发 Cloudflare 自动部署。
- 内部环境使用独立 `litetavern-dev` Pages 项目，已部署应用并由 Cloudflare Access 保护。
  原 `litetavern-internal` 项目名已永久停用：删除后 Cloudflare 边缘仍继续提供一个已删除的、
  无访问控制的部署，重建同名项目会把它一并复活。该名称不得再使用。
- 生产部署保持冻结：`PRODUCTION_RELEASE_ENABLED=false`。
- 在生产后端、持久化和密钥边界确认前，不得解除冻结。

## 分支模型

```text
feature/* ──local merge──> develop ──cut──> release/*
                                          │
                                          ├── protected staging
                                          ├── RC tag + Draft Release
                                          └──manual approval + merge──> main
                                                                         │
                                                                         └──stable tag/Release──> production

stable tag ──fix──> hotfix/* ──> protected staging ──> main + develop
```

分支规则：

| 目标      | 允许来源                          | 必需条件                                   |
| --------- | --------------------------------- | ------------------------------------------ |
| `develop` | 本地验证后的开发提交、`feature/*` | 推送前运行 `npm run check`，推送后 CI 复验 |
| `main`    | `release/*`、`hotfix/*`           | staging、RC 和用户明确确认均已完成         |

单人开发不强制创建 PR 或自己审批自己。`develop` 允许在本地全量检查后直接 push；`main` 禁止日常开发直推，只允许已验收的 Release/Hotfix 合入。两个长期分支都禁止 force-push 和删除。PR 仅作为未来多人协作、外部贡献或异步审查时的可选路径。

## 环境隔离

| 环境       | 用途             | 访问              | 部署来源                      |
| ---------- | ---------------- | ----------------- | ----------------------------- |
| Local      | 开发和自动化测试 | 本机              | 任意开发分支                  |
| Staging    | 内测与 RC 验收   | Cloudflare Access | `release/*`、`hotfix/*`       |
| Production | 对外稳定版本     | 公网              | 已发布稳定 Release 的校验产物 |

Staging 使用独立 Pages 项目，名为 `litetavern-dev`：

```text
https://litetavern-dev.pages.dev
```

Cloudflare Pages 的预览 URL 默认公开，且每次部署都会多出一个 `<hash>.<project>.pages.dev`
主机名。因此 Access 应用的 destination 必须同时覆盖项目根域和通配符：

```text
litetavern-dev.pages.dev
*.litetavern-dev.pages.dev
```

只保护根域会让每一次部署都留下一个可公开访问的 URL。访问控制不得仅依赖 `noindex`、
不可猜测链接或搜索引擎未收录。

当前状态：Access 应用 `LiteTavern Dev` 已生效，身份提供商限定为 One-time PIN，
策略为邮箱白名单 Allow。匿名请求根路径和 `/v1/` 均返回到 `*.cloudflareaccess.com`
的 302。白名单外的邮箱同样会收到验证码，但在输入验证码之后才被拒绝 —— Access 先确认
身份再套策略，所以“收不到验证码”不是判断有没有权限的依据。

Production 使用独立 Pages 项目，默认名为 `litetavern`。不得用 staging 项目、预览分支或本地目录直接覆盖生产。

## 发布流程

1. 功能在本地通过 `npm run check` 后合入并推送 `develop`，远端 CI 再次复验。
2. 从 `develop` 创建 `release/X.Y.Z`。
3. 自动化检查、生产依赖审计通过后，部署到受 Access 保护的 staging。
4. 人工完成核心路径验收；确认后运行 “Create release candidate”：
   - 创建 `vX.Y.Z-rc.N` annotated tag；
   - 创建 Draft + Prerelease GitHub Release；
   - 附加 Web 构建产物和 SHA-256。
5. RC 验收通过并获得用户明确确认后，将 release 分支合入 `main`。
6. 人工运行 “Publish stable release”：
   - 验证 RC 已进入 `main`；
   - 重新执行完整检查与安全审计；
   - 为 `main` 创建 `vX.Y.Z`；
   - 发布不可覆盖的稳定 GitHub Release 和校验产物。
7. 人工运行 “Deploy production”，并通过 `production` Environment 的审批：
   - `PRODUCTION_RELEASE_ENABLED` 必须显式为 `true`；
   - 只下载稳定 Release 中的产物；
   - 校验 SHA-256；
   - 部署相同产物，不在生产工作流中重建。
8. 部署后验证 `/`、`/support?source=github` 和必要健康检查。失败时停止发布并按回滚流程处理。

## 回滚

回滚不是重新构建旧提交。运行 “Roll back production”，选择一个已经发布的稳定 tag；工作流下载该 Release 的原始产物、校验 SHA-256、经过 production 审批后恢复，并重新执行部署验证。

禁止删除或移动已发布标签来伪造回滚。发现标签与 Release 不一致时必须停止。

## GitHub 配置状态

2026-07-28 已完成：

- 创建 `staging`、`release-candidate`、`release`、`production` Environments。
- `production` 配置仓库所有者为 required reviewer。
- 写入以下非敏感 Repository variables：
  `CLOUDFLARE_STAGING_PROJECT`、`LITETAVERN_STAGING_URL`、
  `STAGING_ACCESS_ENABLED`、`CLOUDFLARE_PRODUCTION_PROJECT`、
  `LITETAVERN_PRODUCTION_URL`、`PRODUCTION_RELEASE_ENABLED`。
- staging Access 门禁已开启，production 发布门禁继续保持关闭：

```text
STAGING_ACCESS_ENABLED=true
PRODUCTION_RELEASE_ENABLED=false
```

当前配置：

- 将默认开发目标设为 `develop`（`main` 仍是生产分支）。
- 为 `develop` 和 `main` 启用与单人流程兼容的 Ruleset/Branch protection。
- 不强制 PR 或审批；禁止 force-push 和分支删除。
- `develop` 在每次 push 后运行 `validate`；`main` 的任何推进仍必须遵守 staging、RC、稳定 Release 与生产审批门禁。
- Repository secrets 已配置 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`。
- staging 使用 `litetavern-dev` 和
  `https://staging.litetavern-dev.pages.dev`；2026-07-30 已验证根域、
  `/v1/`、最新预览域及其 `/v1/` 均返回 Access 挑战。
- staging 尚未配置可选的 `CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`；
  部署验证会检查匿名 Access 挑战，但会跳过登录后的页面路由检查。
- 在生产后端与持久化决策完成后，才讨论把 `PRODUCTION_RELEASE_ENABLED` 改为 `true`。

## 禁止事项

- 不得从本地直接上传生产。
- 不得把“单人开发免 PR”解释为允许在 `main` 上日常开发或跳过发布验收。
- 不得把当前手工部署反向认定为稳定 Release。
- 不得为未合入 `main` 的提交创建稳定 tag。
- 不得跳过、弱化或删除失败的测试和安全审计。
- 不得在 Actions、仓库、Release 附件或日志中提交真实密钥。
- 不得把 staging URL 公开传播；Access 才是访问边界。
