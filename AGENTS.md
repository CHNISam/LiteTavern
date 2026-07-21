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

## 设计 Skills 使用规则（强制）

本项目优先采用 [emilkowalski/skills](https://github.com/emilkowalski/skills) 提供的设计工程方法。涉及 UI 设计、界面实现、视觉打磨、交互细节或动效时，必须按任务选择最小且匹配的技能组合，不得无目的地同时加载全部设计技能。

### 优先级

1. `emil-design-eng` 是本项目 UI 设计与设计工程任务的默认首选技能。设计新界面、实现或打磨组件、评审 UI 质量、决定动效是否必要时，必须优先完整读取并使用该技能。
2. `emilkowalski/skills` 的判断在 UI 品味、视觉细节、组件质感和动效设计方面优先于 `ui-ux-pro-max` 等通用 UI/UX 技能。
3. `ui-ux-pro-max` 等通用技能仅用于补充更广泛的 UX 研究、信息架构、设计系统或该技能包未覆盖的事项；不得用其通用建议覆盖 `emil-design-eng` 的具体设计工程规则。
4. “重点使用”不等于堆叠技能。仅在当前任务命中触发范围时加载专用技能，并严格遵守其只读、只评审或只规划等操作边界。

### 技能路由

- `emil-design-eng`：默认用于 UI 创建、组件设计、视觉打磨、交互质感和一般动效决策。
- `apple-design`：仅在任务涉及 Apple 风格设计基础、手势驱动交互、弹簧与动量、拖拽/滑动/Sheet、可中断动画、空间连续性、半透明材质、层次、字体细节或 reduced-motion 时，与 `emil-design-eng` 组合使用。
- `animation-vocabulary`：仅用于把模糊的动效描述映射为准确术语；不得把它当作设计或实现技能。
- `find-animation-opportunities`：用于寻找真正值得增加动效的位置。该技能只读，只输出候选与拒绝项，不得修改源码。
- `improve-animations`：用于全项目动效审计、优先级排序和生成自包含实施计划。该技能不得直接修改源码，其允许写入的内容仅限 `plans/` 或 `animation-plans/`。
- `review-animations`：仅用于严格评审已有动效代码或 diff，不负责实现功能、修复非动效问题或替代通用代码审查。

### 执行要求

- 使用任一设计技能前必须完整读取其 `SKILL.md`；技能要求加载 `STANDARDS.md`、`AUDIT.md`、`PLAN-TEMPLATE.md` 等附属文件时，必须按需完整读取。
- 先确认产品场景、使用频率、交互目的和现有设计语言，再决定是否添加动效。高频或键盘触发操作默认不添加动效。
- 动效必须服务于反馈、空间连续性、状态说明、防止突兀变化或低频愉悦感；不得仅为“看起来酷”而添加。
- Apple 风格的目标是克制、直接、连续、可中断且有物理感，不是机械复制 iOS 外观，也不是滥用毛玻璃、弹跳和长动画。
- 技能建议与项目需求、现有设计系统或用户明确指示冲突时，以用户指示和项目约束为准，并记录关键取舍。

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
