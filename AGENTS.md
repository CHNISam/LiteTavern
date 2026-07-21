# AGENTS.md

本文件适用于本仓库根目录及其所有子目录。所有在本项目中工作的 Agent 必须遵守以下规则。

## Git 工作流（强制）

1. 所有涉及 Git 的操作必须严格遵循 `git-workflow` skill，不得凭经验跳过或自行简化其规范。
2. 在执行分支创建、提交、推送、拉取、合并、变基、PR、发布、CI/CD 或 Git hooks 等操作前，必须先完整读取 `git-workflow/SKILL.md`。
3. 当 `git-workflow` skill 指定了与当前任务匹配的参考文件时，必须在操作前完整读取对应文件：
   - 分支策略：`references/branching-strategies.md`
   - Commit 与语义化版本：`references/commit-conventions.md`
   - PR、审查、合并、冲突与 CI 检查：`references/pull-request-workflow.md`
   - CI/CD：`references/ci-cd-integration.md`
   - Rebase、Cherry-pick、Bisect 等高级操作：`references/advanced-git.md`
   - Release：`references/github-releases.md`
   - Git hooks：`references/git-hooks-setup.md`
4. 默认采用 GitHub Flow；分支命名、Commit 格式和 PR 流程必须符合该 skill 的要求。
5. Commit 必须使用 Conventional Commits：`<type>[scope]: <description>`。
6. 执行任何可能改写历史、覆盖文件、删除分支或标签的操作前，必须先检查当前分支、工作区状态、远端和目标范围；未获用户明确授权时不得执行破坏性操作。
7. 不得覆盖或丢弃用户已有的未提交改动。发现脏工作区或与任务无关的改动时，必须保留并绕开。
8. 在声称 Git 操作完成前，必须以最新命令输出验证分支、跟踪关系、工作区状态及相关远端结果。
9. 远端连接优先使用 HTTPS；除非用户明确要求，不得擅自改用 SSH。

## 重点参考仓库

以下仓库是本项目进行需求分析、架构设计、交互设计和实现调研时的重点参考对象：

1. Claude Code Analysis
   - 仓库：https://github.com/liuup/claude-code-analysis
   - 用途：作为 Claude Code 相关机制、Agent 行为和工程实现分析的重要参考。
2. SillyTavern
   - 仓库：https://github.com/SillyTavern/SillyTavern
   - 用途：作为聊天产品架构、交互模式、扩展能力和相关工程实践的重要参考。

使用参考仓库时必须遵守以下要求：

- 优先阅读其公开文档、源码和提交历史，以事实为依据，不得臆测其实现。
- 参考不等于照搬；必须结合 PomChat 的目标、现有架构和约束进行取舍。
- 引入代码、配置、资源或设计前必须核对对应许可证及兼容性，并保留必要的版权和来源说明。
- 不得把参考仓库中的密钥、凭据、私有配置、构建产物或无关代码复制进本项目。
- 若两个参考仓库的做法冲突，应以本项目需求、现有技术决策和用户明确指示为最高依据，并记录关键取舍。
