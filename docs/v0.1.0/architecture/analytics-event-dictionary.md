# PomChat v0.1.0 埋点字典

所有时间保存为 `TIMESTAMPTZ`，指标按 UTC 自然日计算。客户端事件写入失败不影响聊天；
服务端通过匿名 HttpOnly Cookie 解析 `anonymous_id` 和 `user_id`，不信任客户端自报身份。

| 事件名 | 触发时机 | 触发端 | 必填字段 | 可选字段 | 去重方式 | 用途 | 隐私说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `app_session_started` | 无有效 Session 或 30 分钟无活动后访问 | Web | `event_id`, `session_id`, `occurred_at`, `source_channel`, `is_first_visit`, `session_number` | UTM/ref、设备、locale、首/本次来源 | `event_id` 主键 | 新增、渠道、Session | 不采集正文或凭证 |
| `page_view` | 进入当前真实页面/覆盖层 | Web | `event_id`, `session_id`, `occurred_at`, `page_name`, `page_path`, `page_view_index`, `page_depth` | `from_page`, `entry_method`, 角色/会话 ID | `event_id` 主键 | 路径、深度、进入/退出 | 只有页面和业务 ID |
| `critical_action` | 角色选择、开始聊天、首次发送尝试、创建/导入/Provider 配置或登录开始 | Web | `event_id`, `session_id`, `occurred_at`, `page_name`, `action_name`, `interaction_index` | 角色/会话 ID、result | `event_id` 主键 | 核心漏斗 | 不记录输入和普通点击 |
| `core_blocking_error_shown` | 会阻止聊天或核心体验的错误展示 | Web | `event_id`, `session_id`, `occurred_at`, `page_name`, `error_code`, `error_stage`, `retryable` | request/角色/会话 ID | `event_id` 主键 | 阻断诊断 | 错误码已清洗 |

当前真实页面名：

```text
home
chat
character_detail
character_memories
character_settings
character_create
character_import
model_config
```

以下成功事实直接查询业务表，不由前端声明：

- 匿名创建/身份关联：`app_user`、`app_user_identity`
- 角色创建/导入：`agent_character`、`agent_character_card_version`
- 会话与消息：`chat_conversation`、`chat_message`
- 模型开始/完成/失败、Provider、模型、Token、延迟：
  `agent_generation_request`、`model_usage_ledger`

## 指标定义与查询入口

`getAnalyticsOverview(database, { from, to, effectiveChatTurns })` 返回：

- 新增用户及按首次 `source_channel + campaign_id` 分组的新增/激活率；
- Session 最大页面深度、页面数、关键交互数；
- 页面进入 Session、退出 Session 和下一页转化率；
- 首次聊天激活（完成的用户消息对应至少一条完成的助手消息）；
- 默认 3 组成功回复的有效聊天；
- 有效聊天后新 Session 或后续自然日的同角色回访；
- D1/D7 持续聊天留存及同角色留存。

阈值只在指标调用参数中定义，不作为客户端事件上报。首次渠道写入
`app_user.first_source_channel` 后不被后续 direct 访问覆盖。

分析 schema 禁止 `api_key`、Authorization/token、密码、`content_text`、消息正文、
请求正文和完整角色卡字段。
