# ADR 0002：受控发布与环境隔离

- 状态：Accepted
- 日期：2026-07-28

## 背景

项目曾把本地手工构建直接上传到以 LiteTavern 命名的 Pages 站点，并因此产生“临时预览是否已是生产”“是否应当补打标签”的混淆。与此同时，`main` 被视为生产分支，却缺少标签、Release、保护规则、人工审批和 staging 访问控制。

这类问题不能只依赖操作人员记忆，需要在分支、CI、环境和部署脚本四层同时建立门禁。

## 决策

1. 采用 `feature/* → develop → release/* → main` 的受控 GitFlow；单人开发在本地全量检查后可直接推进 `develop`，不强制 PR 或自我审批；Hotfix 单独回合 `main` 与 `develop`。
2. `main` 只承载稳定生产版本，稳定版本必须同时拥有 `vX.Y.Z` 标签和已发布 GitHub Release。
3. RC 使用 `vX.Y.Z-rc.N`，并创建 Draft + Prerelease。
4. staging 与 production 使用两个独立 Cloudflare Pages 项目。
5. staging 必须由 Cloudflare Access 保护；`STAGING_ACCESS_ENABLED` 未开启时 CI 拒绝部署。
6. production 默认冻结；只允许手动工作流在 GitHub Environment 审批后部署。
7. production 只部署稳定 Release 中附带并通过 SHA-256 校验的产物，避免“验收的是 A，生产重建成 B”。
8. 历史手工预览不补打稳定标签、不补建 Release，也不作为生产基线。

## 后果

正面影响：

- 每次生产变更都有 commit、tag、Release、产物哈希、审批与部署记录。
- staging 泄露风险由真实身份访问控制降低，而不是依赖隐蔽 URL。
- 回滚可以恢复一个已知稳定产物，不需要现场重建。
- 单人开发不需要为形式合规创建 PR，但免 PR 不会放宽 `main`、Release 或生产部署门禁。

成本：

- 发布比本地上传多出 staging、RC、Release 与 production 审批步骤。
- 仓库管理员需要配置 GitHub Rulesets、Environments、Secrets 和 Cloudflare Access。
- 当前高危依赖审计未清零前，RC 与稳定 Release 工作流会失败；这是有意的发布阻断。

## 备选方案

- GitHub Flow + 合入 `main` 自动部署：不满足生产必须二次确认的要求。
- 单一 Pages 项目同时承担 staging 与 production：访问策略和误部署边界不够清晰。
- 继续手工 Wrangler 上传：无法保证构建产物、审批和 Release 的一致性。
