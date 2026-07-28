# LiteTavern 发布与环境治理

本规范用于防止未经验证的代码、错误命名的站点和本地临时构建进入生产。它适用于所有开发者、Agent、GitHub Actions 和 Cloudflare Pages 操作。

## 当前安全状态

- `main` 视为生产分支，但在首个合规稳定 Release 前不代表已有可发布产品。
- 现有 `litetavern.pages.dev` 手工上传内容属于历史临时预览，不据此补打标签、创建 Release 或宣称生产已发布。
- 历史 Git 集成 Pages 项目已删除，后续 Git push 不再旁路触发 Cloudflare 自动部署。
- 独立 `litetavern-internal` Pages 项目已创建但保持空白；Access 生效前不上传应用。
- 生产部署保持冻结：`PRODUCTION_RELEASE_ENABLED=false`。
- 在生产后端、持久化和密钥边界确认前，不得解除冻结。

## 分支模型

```text
feature/* ──PR──> develop ──cut──> release/*
                                     │
                                     ├── protected staging
                                     ├── RC tag + Draft Release
                                     └──PR──> main ──stable tag/Release──> production

stable tag ──fix──> hotfix/* ──> protected staging ──> main + develop
```

受保护分支规则：

| 目标      | 允许来源                             | 必需检查                    |
| --------- | ------------------------------------ | --------------------------- |
| `develop` | `feature/*`、`release/*`、`hotfix/*` | `validate`                  |
| `main`    | `release/*`、`hotfix/*`              | `validate`、Code Owner 审查 |

`main` 和 `develop` 禁止直接 push、force-push 和删除。Release/Hotfix 合入后保留可审计的 PR 与 CI 记录。

## 环境隔离

| 环境       | 用途             | 访问              | 部署来源                      |
| ---------- | ---------------- | ----------------- | ----------------------------- |
| Local      | 开发和自动化测试 | 本机              | 任意开发分支                  |
| Staging    | 内测与 RC 验收   | Cloudflare Access | `release/*`、`hotfix/*`       |
| Production | 对外稳定版本     | 公网              | 已发布稳定 Release 的校验产物 |

Staging 使用独立 Pages 项目，默认名为 `litetavern-internal`。固定预览别名为：

```text
https://staging.litetavern-internal.pages.dev
```

Cloudflare Pages 的预览 URL 默认公开。必须先在 Pages 设置中启用 Access，并确认匿名请求得到 Access 登录跳转或 `401/403`，之后才能把仓库变量 `STAGING_ACCESS_ENABLED` 设为 `true`。不得仅凭 `noindex`、不可猜测链接或搜索引擎未收录来替代访问控制。

Production 使用独立 Pages 项目，默认名为 `litetavern`。不得用 staging 项目、预览分支或本地目录直接覆盖生产。

## 发布流程

1. 功能通过 PR 合入 `develop`，CI 全绿。
2. 从 `develop` 创建 `release/X.Y.Z`。
3. 自动化检查、生产依赖审计通过后，部署到受 Access 保护的 staging。
4. 人工完成核心路径验收；确认后运行 “Create release candidate”：
   - 创建 `vX.Y.Z-rc.N` annotated tag；
   - 创建 Draft + Prerelease GitHub Release；
   - 附加 Web 构建产物和 SHA-256。
5. RC 验收通过后，将 release PR 合入 `main`。
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
- 两个部署开关保持关闭：

```text
STAGING_ACCESS_ENABLED=false
PRODUCTION_RELEASE_ENABLED=false
```

工作流合入 `develop` 后，由仓库管理员完成：

- 将默认开发目标设为 `develop`（`main` 仍是生产分支）。
- 为 `develop` 和 `main` 启用 Ruleset/Branch protection。
- 要求 PR、至少 1 位审核者、Code Owner 审查和 `validate` 状态检查。
- 禁止 force-push、分支删除和绕过规则。
- 配置 Environment secrets：
  `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`；
  staging 另配 `CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`。
- 在 Cloudflare Access 验证通过后，才把 `STAGING_ACCESS_ENABLED` 改为 `true`。
- 在生产后端与持久化决策完成后，才讨论把 `PRODUCTION_RELEASE_ENABLED` 改为 `true`。

## 禁止事项

- 不得从本地直接上传生产。
- 不得把当前手工部署反向认定为稳定 Release。
- 不得为未合入 `main` 的提交创建稳定 tag。
- 不得跳过、弱化或删除失败的测试和安全审计。
- 不得在 Actions、仓库、Release 附件或日志中提交真实密钥。
- 不得把 staging URL 公开传播；Access 才是访问边界。
