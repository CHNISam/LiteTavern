# LiteTavern 发布治理实施计划

## Clarified Goal

把 `main` 固定为受保护生产分支，为开发、内测、候选发布、稳定 Release 和生产部署建立可审计且不可旁路的流程，并将事故经验沉淀为项目与全局 Agent 规范。

## Scope

- 用 skills.ws 版本替换全局 `git-workflow`，同步 Codeup 与 GitHub 备份。
- 采用 `feature/* → develop → release/* → main`，Hotfix 双向回合。
- 建立 CI、protected staging、RC、stable Release、production 和 rollback 工作流。
- 用脚本测试分支、标签、版本、生产开关、Access 和部署路由。
- 彻底完成 LiteTavern 品牌迁移，禁止旧品牌重新进入仓库。
- 更新 AGENTS、ADR、发布文档，并保留 PR 模板和 CODEOWNERS 供未来多人协作时选用。

## Constraints

- 不直接修改 `main`。
- 不为历史手工预览补打标签或创建 Release。
- 不创建稳定 Release，不部署 production。
- staging 未配置 Cloudflare Access 前不得部署业务内容。
- 不提交真实凭证。

## Definition of Done

- 新增策略测试和仓库全量检查通过。
- GitHub Actions 生产开关默认关闭，部署只能使用已发布稳定产物。
- staging 与 production 项目和访问边界分离。
- 单人开发在本地全量检查后直接合入并推送 `develop`，无需形式化 PR 或自我审批。

## Open Questions

- 生产后端与持久化最终托管方案。
- GitHub 计划是否支持所需 Environment 审批能力。
- Cloudflare Access 允许的成员或身份提供方名单。
