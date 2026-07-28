# PomChat v0.1.0 官方免费额度

## 数据模型

采用方案 A：`app_user` 保存 `free_quota_total`、`free_quota_remaining`、
`free_quota_reserved` 和 `free_quota_granted_at`，`free_quota_ledger` 保存赠送、
预留、消费、释放和失败流水。

匿名身份与登录身份本来就共享稳定的 `app_user.user_id`。余额直接属于用户可避免
账户映射、登录迁移和第二套用户生命周期；流水表只补充审计，不复制聊天或模型请求事实。

## 调用流程

```text
匿名 Cookie → user_id → 业务校验
→ 单用户/IP/全站保护
→ 原子预留 1 个可用名额（余额不变）
→ Groq
   ├─ 成功 → 记录实际 Provider/Token/延迟 → 原子扣减 → 返回余额
   └─ 429/5xx/超时/网络错误 → Cloudflare Workers AI
       ├─ 成功 → 原子扣减一次 → 返回余额
       └─ 失败 → 释放预留 → 统一繁忙错误
```

预留使用条件更新：

```sql
UPDATE app_user
SET free_quota_reserved = free_quota_reserved + 1
WHERE free_quota_remaining - free_quota_reserved > 0;
```

成功后结算：

```sql
UPDATE app_user
SET free_quota_remaining = free_quota_remaining - 1,
    free_quota_reserved = free_quota_reserved - 1
WHERE free_quota_remaining > 0 AND free_quota_reserved > 0;
```

同一用户的 `request_id + action_type` 唯一，重复请求不会再次预留或扣减。失败只释放
预留，余额不变。

## 主备切换

仅 `PROVIDER_RATE_LIMITED`、`PROVIDER_TIMEOUT`、`PROVIDER_UNAVAILABLE`
允许切换备用通道。凭证配置错误、参数错误、内容安全拒绝和其他不可重试 4xx 不切换。
流式请求只有在主通道尚未输出 token 时才安全切换；若已输出后中断，该回复标记失败且
不扣额度，避免拼接两家 Provider 的重复文本。

普通用户响应不包含实际 Provider、上游错误、密钥或堆栈。服务端请求记录可查询实际
Provider、模型、Token、延迟、主备尝试和 Provider 请求 ID（上游返回时）。

## 匿名身份与登录认领

首次 `POST /v1/identities/anonymous` 在一个事务内创建用户、匿名身份和一次 30 次赠送
流水；HttpOnly、SameSite=Lax 的随机凭证用于恢复同一匿名身份。

`claimAuthenticatedIdentity` 只供已验证账号/OAuth subject 的服务端认证回调调用。
它在同一个 `user_id` 上增加身份记录，因此角色、会话、消息、记忆、额度和流水不迁移、
不重置。重复回调幂等；subject 已属于其他用户时拒绝关联。当前仓库尚无账号/OAuth
Provider，因此没有暴露可由浏览器提交任意 subject 的公共认领接口。

## 本地配置

1. 复制 `.env.example` 为本地环境文件，但不要提交该文件。
2. 在 Groq 控制台创建 Key，设置 `GROQ_API_KEY`；按需修改 `GROQ_MODEL`。
3. 在 Cloudflare 创建仅允许 Workers AI 调用的 API Token，设置
   `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_MODEL`。
4. 保持 `FREE_PROVIDER_PRIMARY=groq`、`FREE_PROVIDER_FALLBACK=cloudflare`。
5. 启动 API；凭证只由服务端读取，浏览器只访问 PomChat `/v1` 接口。

真实凭证不得写入 Git、前端、响应或日志。
