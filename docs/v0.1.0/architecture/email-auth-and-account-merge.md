# 邮箱验证码登录、匿名升级与账号合并

> v0.1.0 · 迁移版本 `6 email_auth`

PomChat 默认免注册使用。登录只用于跨设备同步、数据恢复与把匿名身份升级为可恢复的正式身份。首版统一使用 **邮箱 + 6 位验证码**，不区分「注册」和「登录」。

## 身份模型

沿用既有 `app_user` + `app_user_identity` 多身份结构，未新造用户实体：

- 每台设备的会话令牌 = 一条 `identity_type = 'ANONYMOUS'` 的身份行，`pomchat_anon` Cookie 保存其明文 token，服务端只存 `sha256` 哈希。
- 「正式账号」= 该 `app_user` 拥有一条 `identity_type = 'EMAIL'` 身份行，并在 `app_user.email` 冗余规范化邮箱用于展示。
- `identity_type` CHECK 扩展为 `ANONYMOUS | ACCOUNT | OAUTH | EMAIL`；`app_user.status` 扩展出 `MERGED`。

邮箱在哈希与唯一性判断前统一规范化（去首尾空格、整体小写）。EMAIL 身份的 `subject_hash = sha256("EMAIL:" + 规范化邮箱)`。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/auth/email-code/send` | 发送验证码。响应恒为 `{ success, message }`，不泄露邮箱是否已注册。 |
| POST | `/v1/auth/email-code/verify` | 校验验证码并完成登录/升级/合并，轮换会话 Cookie，返回 `{ user, outcome }`。 |
| POST | `/v1/auth/logout` | 吊销当前设备会话身份并清除 Cookie；前端随后重新创建全新匿名身份。 |

`outcome ∈ { REGISTERED, LOGGED_IN, MERGED }`。

### verify 后端自动判定

```
邮箱未绑定            → 当前匿名账号原地升级（user_id 不变，新增 EMAIL 身份）  → REGISTERED
邮箱已绑定当前账号     → 保持登录                                            → LOGGED_IN
邮箱已绑定其他正式账号  → 登录该账号；若当前为匿名会话则合并其数据            → MERGED / LOGGED_IN
```

已注册会话再验证「另一个已有账号」的邮箱时按纯登录切换处理，不自动合并两个正式账号的数据。

## 验证码安全

- 哈希存储（`sha256(email:code)`），永不落库明文，不进日志/异常/埋点。
- 有效期 10 分钟；单次使用（成功即 `consumed_at`）。
- 失败累计到 5 次即锁定该验证码（`CODE_ATTEMPTS_EXCEEDED`）。
- 新验证码作废旧验证码（每邮箱仅一条 active，`idx_email_code_active`）。
- 限流：同邮箱 60s 重发冷却、每邮箱每小时 5 条、每 IP 每小时 20 条 → `CODE_SEND_RATE_LIMITED`。
- 验证码校验与吊销在独立提交步骤中进行，因此错误尝试计数不会随升级/合并事务回滚而丢失。
- 发送响应对「已注册 / 未注册」完全一致，无法枚举账号。

错误码：`INVALID_EMAIL`（Zod 校验为 `VALIDATION_ERROR`）、`CODE_SEND_RATE_LIMITED`、`CODE_INVALID`、`CODE_EXPIRED`、`CODE_ATTEMPTS_EXCEEDED`、`AUTH_MERGE_FAILED`。

## 账号合并规则

`mergeUserData(source → target)`，整体在单事务内、幂等（`auth_account_merge.source_user_id` 唯一 + 源账号 `MERGED` 短路）：

1. 内容数据改归属，不改主键：`agent_character.owner_user_id`；`chat_conversation / model_configuration / agent_generation_request / agent_memory / provider_connection / analytics_event` 的 `user_id`。会话摘要、消息、记忆来源、角色卡版本、后处理任务经由上述外键随之归属。
2. `agent_relationship`（`UNIQUE(user_id, character_id)`）仅迁移 target 尚无的行，冲突时保留 target，不覆盖。
3. **额度与账本不叠加、不删除、不重复**：`free_quota_ledger`、`model_usage_ledger` 保留在源账号供审计，target 额度保持不变。
4. 敏感凭证（BYOK API Key 存于浏览器本地/OS keyring）不因归属变更被覆盖。
5. 源账号置 `MERGED`、记 `merged_into_user_id`、吊销其全部身份，不再产生独立数据。
6. 记录 `auth_account_merge` 审计（不含验证码或完整凭证）。

## 会话与 Cookie

- `HttpOnly`、生产 `Secure`、`SameSite=Lax`、32 字节随机 token、服务端仅存哈希。
- 升级/登录/合并成功后轮换会话（`rotateSessionIdentity`）：吊销旧匿名身份、以新 token 绑定目标账号，防止会话固定；匿名升级时 `user_id` 不变、数据不丢。
- 退出后重建全新匿名身份，不复用已退出会话。

## 邮件发送

`EmailProvider` 抽象（`email-provider.ts`）：

- 开发：`ConsoleEmailProvider` 把验证码打印到服务端日志（生产禁用）。
- 测试：`MemoryEmailProvider` 记录已发验证码。
- 生产：`HttpEmailProvider`，通过环境变量配置，不硬编码任何具体服务商。

### 生产待配置环境变量

`EMAIL_PROVIDER=http`、`EMAIL_HTTP_ENDPOINT`、`EMAIL_HTTP_API_KEY`、`EMAIL_FROM_ADDRESS`、（可选）`EMAIL_HTTP_TIMEOUT_MS`。缺失时非生产回退到 console 适配器，生产则显式报错。

## 已知限制 / 后续建议

- `HttpEmailProvider` 为通用 POST 抽象，接入具体服务商时需按其协议实现或调整字段映射。
- 尚未实现「产生若干轮对话后轻量提示登录」的软引导；入口已常驻顶栏，验收标准不依赖软引导。
- 合并只处理当前版本已存在的数据表，新增用户数据表时需在 `REASSIGN_BY_USER_ID` 或合并逻辑中补充。
- 限流基于单 API 进程的数据库计数；多实例部署需引入共享限流。
