# LiteTavern v0.1.0 SillyTavern 兼容契约

日期：2026-07-30

参考版本：

- SillyTavern `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`
- Character Card V2 / V3 规范

## Clarified Goal

LiteTavern v0.1.0 要成为一个可验证的字符串编排客户端：AI 角色卡、玩家
Persona、Worldbook、宏和 Regex 是独立资产；每轮生成只把已解析、已激活且经过
显式授权的内容按稳定顺序送入模型；快捷回复必须是玩家可以直接发送的第一人称
发言。

## Scope

### 包含

1. AI 角色继续正式支持 Tavern Card V1、Character Card V2/V3 的 JSON 与 PNG，
   未建模字段原样往返。
2. 玩家 Persona 是本地优先的角色扮演身份，不与账号资料混合；支持 LiteTavern
   导入导出，并识别 SillyTavern 设置导出中的 `personas` /
   `persona_descriptions` 基础字段。
3. Worldbook 可导入和导出：
   - Character Card V2/V3 `data.character_book`；
   - SillyTavern World Info JSON（`entries` 为 uid 对象）；
   - Character Book 规范（`entries` 为数组）。
4. v0.1.0 执行下列 Worldbook 语义：
   - enabled / constant；
   - primary key 与四种 secondary-key logic；
   - 大小写、整词和 `/pattern/flags` Regex key；
   - 书级和条目级 scan depth；
   - priority、insertion order、token budget；
   - probability；
   - 有界递归扫描；
   - `BEFORE_CHAR`、`AFTER_CHAR` 与消息深度注入。
5. v0.1.0 执行核心 SillyTavern 宏：
   `user`、`char`、`persona`、`description`、`personality`、`scenario`、
   `mesExamples`、`original`、`time`、`date`、`weekday`、`isotime`、
   `isodate`、`newline`、`space`。宏名大小写不敏感，递归替换有硬上限。
6. Regex 使用 SillyTavern `regex_scripts` 的核心数据形状，支持
   USER_INPUT、AI_OUTPUT、WORLD_INFO placement、捕获组、`{{match}}`、
   trim strings 与宏替换。角色卡携带的 Regex 默认不执行，必须由用户对该角色
   显式授权。
7. 上下文按命名 segment 组装，并把内容与位置一起传给 Cloud。服务端继续负责
   最终权限边界、长度校验、宏解析和 prompt 排序；持久化 manifest 只记录 ID，
   不记录 Persona、Worldbook 或 Regex 文本。
8. 快捷回复的生成契约、解析、UI 文案和点击发送均明确为 USER 第一人称发言。
9. SillyTavern 风格的写作工具按可观察行为独立实现：
   - `Impersonate` 复用 USER 第一人称候选契约，只填入输入框，不自动发送或落库；
   - 用户配置的 `Quick Replies` 保存在浏览器本地，与 AI 动态生成的“建议回复”分开；
   - Quick Replies 支持启停、排序、填入输入框，并允许用户显式改为点击后直接发送。

### 暂不执行但必须保留

- Worldbook vector search；
- sticky / cooldown / delay；
- inclusion group 的随机抽选与 group scoring；
- Author's Note、example-message top/bottom、outlet 等当前产品没有对应模块的位置；
- SillyTavern 实验性 Macro Engine 的条件、变量、slash command 与嵌套语法；
- Regex Markdown-only 展示重写、reasoning placement 和 Overlay。

这些字段导入后保存在 `source_fields` / `extensions`，导出时原样恢复；界面不得把
“已保留”描述成“已生效”。

## Constraints

1. `LiteTavern` 保持 GPL-3.0；SillyTavern 当前为 AGPL-3.0。本任务参考其公开
   格式、测试思路和可观察行为，独立实现，不直接复制其源码。
2. Persona、Worldbook、Regex 授权和浏览器本地资产属于开源客户端；
   官方鉴权、模型网关、额度和最终 prompt 组装属于 LiteTavern Cloud。
3. 旧客户端仍可使用 Cloud 中已有 Persona / Worldbook；新客户端提交的本地
   `prompt_context` 优先用于当前轮，不删除或迁移服务器已有数据。
4. 所有来自角色卡、Worldbook、Persona 与 Regex 的文字都视为用户内容：
   有长度/数量上限，不进入日志和分析属性，不获得高于系统安全规则的权限。
5. Regex pattern 与待处理文本有硬上限，并拒绝明显的嵌套量词，避免浏览器被
   灾难性回溯锁死。

## Context Order

```text
system safety / default instruction
character identity
worldbook BEFORE_CHAR
character description + personality + scenario
example dialogue
worldbook AFTER_CHAR
player Persona
relationship summary
post-history instructions
relationship data + memory + world canon
message-depth worldbook segments
chat history
```

角色卡 `system_prompt` 中的 `{{original}}` 只展开一次。`{{user}}` 始终指玩家
Persona，`{{char}}` 始终指当前 AI 角色；快捷回复不会交换这两个身份。

## Definition of Done

1. 上述每个“包含”条目都有单元测试或集成测试，且相关模块测试通过。
2. SillyTavern World Info / Character Book fixture 可导入、触发、预算裁剪并等价
   导出；未知字段仍在。
3. 带内嵌 Character Book 与 Regex 的角色卡导入后，本地资产正确关联；Regex
   未授权时不运行，授权后只在声明 placement 运行。
4. 一次聊天请求携带当前 Persona 和本轮激活条目；Cloud 校验边界并按约定顺序
   组装，manifest 不包含内容文本。
5. UI 快捷回复显示为“你可以这样说”，点击后落库为 USER 消息；服务端生成提示
   明确禁止输出 AI 角色台词作为 suggestion。
6. `Impersonate` 生成后只更新输入框；用户未确认发送前不新增 USER 消息，也不触发角色生成。
   本地 Quick Replies 可配置、启停和排序，默认点击只填入输入框，且不会覆盖已有草稿。
7. 两个仓库分别通过新增/相关测试、typecheck、lint 和 build；全量测试未运行时
   必须说明原因。

## Open Questions

无阻塞问题。Cloud 中已有 Persona / Worldbook 数据暂保留为旧客户端兼容来源；
未来是否提供一次性迁移到本地库，留待 Cloud Sync/Backup 产品规则确定后单独决策。
