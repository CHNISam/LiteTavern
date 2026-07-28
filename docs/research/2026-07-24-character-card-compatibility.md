# LiteTavern v0.1.0 角色卡兼容与字段映射

## 结论

LiteTavern 的运行时只读取内部角色模型。外部角色卡是输入/输出格式，不会直接成为提示词或运行时对象。

首批兼容范围：

| 外部格式 | 容器 | v0.1.0 等级 | 说明 |
| --- | --- | --- | --- |
| Tavern Card V1 | JSON、PNG `chara` | 兼容支持 | 按扁平字段结构检测，不依赖扩展名；未知字段保留 |
| Character Card V2 2.0 | JSON、PNG `chara` | 正式支持 | 导入、编辑、运行字段、导出和往返测试 |
| Character Card V3 3.0 | JSON、PNG `ccv3` | 正式支持 | `ccv3` 优先于同图中的 `chara`；V3 新增但未运行的字段保留 |
| V2/V3 的未来规范版本 | JSON、PNG | 兼容支持 | 识别既有字段并显示降级提示，不声称新字段已生效 |
| V3 CHARX | ZIP/CHARX | 暂未接入 | 明确报错且不创建角色；不把 ZIP 误判为 JSON/PNG |

规范依据：

- [Character Card V2 Specification](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md)
- [Character Card V3 Specification](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md)
- [SillyTavern Character Management](https://github.com/SillyTavern/SillyTavern-Docs/blob/main/Usage/Characters/index.md)

## 内部模型

每个 READY 角色卡版本明确分为：

- `normalized_data`：LiteTavern 已理解、可编辑的稳定角色设定；
- `passthrough_data`：未知字段和当前不执行的外部字段，按 root/data 层级保留；
- `source_metadata`：来源规范、容器、版本、文件名、媒体类型、大小、校验和、解析器版本、兼容等级和未生效字段；
- 原 PNG 文件：作为头像输入及同容器导出的图像载体保留，不直接执行其中内容。

## 字段映射

| 内部字段 | V1 | V2 / V3 | 参与聊天运行 | 应用内可编辑 | 导出规则 | 缺失默认值 |
| --- | --- | --- | --- | --- | --- | --- |
| `name` | `name` | `data.name` | 是，角色身份 | 基础 | 覆盖规范字段；若存在顶层镜像也同步覆盖 | 必填，空值拒绝 |
| `description` | `description` | `data.description` | 是，角色背景 | 基础 | 覆盖原值 | `""` |
| `personality` | `personality` | `data.personality` | 是，性格与表达 | 高级 | 覆盖原值 | `""` |
| `scenario` | `scenario` | `data.scenario` | 是，当前场景 | 高级 | 覆盖原值 | `""` |
| `first_message` | `first_mes` | `data.first_mes` | 是，新会话开场 | 基础 | 覆盖原值 | `""`，运行时可回退问候 |
| `alternate_greetings` | 无正式字段 | `data.alternate_greetings` | 否，v0.1.0 未提供开场 swipe | 高级 | 覆盖原值并标记未生效 | `[]` |
| `example_messages` | `mes_example` | `data.mes_example` | 是，作为风格参考 | 高级 | 覆盖原值 | `""` |
| `system_prompt` | 无正式字段 | `data.system_prompt` | 是；支持 `{{original}}` | 高级 | 覆盖原值 | `""`，使用 LiteTavern 默认提示 |
| `post_history_instructions` | 无正式字段 | `data.post_history_instructions` | 是，作为本轮后置要求 | 高级 | 覆盖原值 | `""` |
| `tags` | 无正式字段 | `data.tags` | 否，仅管理/展示 | 高级 | 覆盖原值 | `[]` |
| `creator.name` | 无正式字段 | `data.creator` | 否 | 高级 | 覆盖原值 | `""` |
| `creator.notes` | 无正式字段 | `data.creator_notes` | 否 | 高级 | 覆盖原值 | `""` |
| `creator.character_version` | 无正式字段 | `data.character_version` | 否 | 高级 | 覆盖原值 | `""` |
| passthrough root fields | 未映射字段 | `spec/data` 之外字段 | 否 | 否 | 原样合并回外层 | `{}` |
| passthrough data fields | 未映射字段 | `extensions`、`character_book`、`assets`、V3 新字段等 | 否 | 否 | 原样合并回 `data` | `{}` |

`character_book`、V3 assets、group-only greetings、多语言创作者说明、来源数组和扩展字段当前只保留，不进入聊天提示。界面会显示这些未生效路径。

## 检测与导出规则

1. 注册表把原始字节交给各适配器评分检测；新增格式只需注册新适配器。
2. JSON 根据 `spec`、`data` 和实际字段结构识别；V1 根据扁平字段组合识别。
3. PNG 根据签名与 `tEXt` 内容识别；同时存在时 `ccv3` 优先。
4. 字段存在但类型错误时拒绝；缺失的可选字段填入稳定默认值。
5. 导出以 passthrough 为底，使用最新 normalized 字段覆盖已支持字段。
6. PNG 导出替换角色元数据块但保留可用的图像及其他 PNG 块；头像像素损坏时使用安全占位 PNG 承载角色数据。

## 头像数据流

角色表复用 `avatar_object_key`，没有新增图片表。

```text
本地图片 / PNG 角色卡图像
→ 浏览器解码
→ 正方形移动与缩放裁剪
→ 512×512 WebP（必要时降至 448/384）
→ 头像上传 API 复核
→ CharacterAssetStore
→ avatar_object_key
→ 列表 / 档案 / 聊天共用 Avatar 组件
```

策略：

- 输入：JPEG、PNG、WebP，浏览器端最大 12 MB；
- 输出：优先 512×512 WebP，质量 0.86；超过 2 MB 时依次降到 448/384 并降低质量；
- 服务端：最大 2 MB、最长边不超过 1024，并校验文件结构和尺寸；
- 圆形仅为 UI 遮罩，保存资源始终是正方形；
- `avatar_object_key = NULL` 表示可使用角色卡 PNG，空字符串表示用户显式删除头像并使用占位图；
- 角色卡原文件继续单独保留，用于未知字段和同格式导出，不会被裁剪头像覆盖。

本模块不包含图片生成模型、提示词、seed、生成任务、供应商、免费次数、计费或生成历史。
