import {
  Activity,
  BarChart3,
  CircleAlert,
  FlaskConical,
  Gauge,
  LogOut,
  MessageSquareText,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Users
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode
} from 'react';
import {
  AdminApiError,
  adminApi,
  readAdminToken,
  saveAdminToken
} from './admin-api';
import './admin.css';

type Tab = 'overview' | 'alpha' | 'users' | 'feedback' | 'analytics' | 'system';
type JsonRecord = Record<string, unknown>;

const navigation: Array<{ id: Tab; label: string; icon: ReactNode }> = [
  { id: 'overview', label: '概览', icon: <Gauge size={18} /> },
  { id: 'alpha', label: 'Alpha', icon: <FlaskConical size={18} /> },
  { id: 'users', label: '用户', icon: <Users size={18} /> },
  { id: 'feedback', label: '反馈', icon: <MessageSquareText size={18} /> },
  { id: 'analytics', label: '数据分析', icon: <BarChart3 size={18} /> },
  { id: 'system', label: '系统', icon: <Settings2 size={18} /> }
];

const labels: Record<string, string> = {
  total_seats: '总席位',
  released_seats: '已释放席位',
  assigned_seats: '已分配席位',
  remaining_seats: '剩余席位',
  current_batch: '当前批次',
  waitlist_count: '候补人数',
  active_testers: '实际活跃测试者',
  core_loop_completed: '完成核心闭环人数',
  new_anonymous_users: '新增匿名用户',
  new_registered_users: '新增注册用户',
  first_successful_chat_users: '首次成功聊天人数',
  effective_session_users: '有效核心会话人数',
  memory_users: '成功生成记忆人数',
  same_character_revisit_users: '同角色回访人数',
  memory_recall_users: '成功记忆召回人数',
  d1_same_character_rate: 'D1 同角色继续聊天率',
  d7_same_character_rate: 'D7 同角色继续聊天率',
  unresolved_high_priority_feedback: '未解决高优先级反馈',
  recent_generation_failure_rate: '24h 生成失败率',
  platform_quota_consumed: '平台额度消耗',
  estimated_cost_usd: '累计估算成本',
  average_cost_per_activated_user_usd: '平均每激活用户成本'
};

function displayValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') {
    if (key.includes('rate')) return `${(value * 100).toFixed(1)}%`;
    if (key.includes('usd')) return `$${value.toFixed(4)}`;
    return value.toLocaleString('zh-CN');
  }
  return String(value);
}

function MetricGrid({ data }: { data: JsonRecord }) {
  return (
    <div className="admin-metric-grid">
      {Object.entries(data)
        .filter(([, value]) => typeof value !== 'object')
        .map(([key, value]) => (
          <article className="admin-metric" key={key}>
            <span>{labels[key] ?? key.replaceAll('_', ' ')}</span>
            <strong>{displayValue(key, value)}</strong>
          </article>
        ))}
    </div>
  );
}

function Panel({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="admin-panel">
      <header>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    saveAdminToken(token);
    try {
      await adminApi('/api/admin/overview');
      onSuccess();
    } catch (caught) {
      saveAdminToken('');
      setError(caught instanceof Error ? caught.message : '管理员验证失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="admin-login">
      <form onSubmit={(event) => void submit(event)}>
        <ShieldCheck size={28} />
        <p className="admin-kicker">LiteTavern Cloud</p>
        <h1>管理后台</h1>
        <p>此页面不会仅凭路由隐藏提供安全保护。请输入服务端配置的管理员令牌。</p>
        <label>
          管理员令牌
          <input
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoFocus
          />
        </label>
        {error && <p className="admin-error">{error}</p>}
        <button disabled={busy || token.trim().length === 0}>
          {busy ? '验证中…' : '进入后台'}
        </button>
      </form>
    </main>
  );
}

function Overview({ data }: { data: JsonRecord }) {
  const release = (data.release_check ?? {}) as JsonRecord;
  const providers = ((data.risk as JsonRecord | undefined)?.provider_status ??
    []) as JsonRecord[];
  return (
    <>
      <div className="admin-page-heading">
        <div>
          <p className="admin-kicker">Decision console</p>
          <h1>概览</h1>
          <p>只保留下一批 Alpha、核心体验和成本可持续性所需信号。</p>
        </div>
      </div>
      <Panel title="Alpha 状态">
        <MetricGrid data={(data.alpha ?? {}) as JsonRecord} />
      </Panel>
      <Panel title="产品验证">
        <MetricGrid data={(data.product ?? {}) as JsonRecord} />
      </Panel>
      <Panel title="运行风险">
        <MetricGrid data={(data.risk ?? {}) as JsonRecord} />
        <div className="provider-strip">
          {providers.map((provider) => (
            <span key={String(provider.provider)}>
              <i className={provider.enabled ? 'ok' : 'off'} />
              {String(provider.provider)}
            </span>
          ))}
        </div>
      </Panel>
      <Panel
        title="第二批放量检查"
        description="后台不会按日期自动释放。所有检查通过后仍需管理员填写原因并手动确认。"
      >
        <div className={`release-decision ${release.can_open ? 'ready' : ''}`}>
          <strong>
            {release.can_open
              ? '具备手动开放条件'
              : release.configured
                ? '暂不建议开放'
                : '第二批容量尚未配置'}
          </strong>
          <ul>
            {((release.blocking_reasons ?? []) as string[]).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </Panel>
    </>
  );
}

function AlphaModule({
  data,
  reload
}: {
  data: JsonRecord;
  reload: () => Promise<void>;
}) {
  const plan = (data.plan ?? {}) as JsonRecord;
  const seats = (data.seats ?? {}) as JsonRecord;
  const batches = (data.batches ?? []) as JsonRecord[];
  const waitlist = (data.waitlist ?? []) as JsonRecord[];
  const readiness = (data.readiness ?? {}) as JsonRecord;

  async function release(userId: string) {
    const batch = batches.find((item) => item.status === 'OPEN') ?? batches[0];
    if (!batch) return;
    const reason = window.prompt('请填写分配 Alpha 的原因');
    if (!reason?.trim()) return;
    await adminApi(`/api/admin/alpha/batches/${String(batch.batch_id)}/release`, {
      method: 'POST',
      body: JSON.stringify({ user_ids: [userId], reason })
    });
    await reload();
  }

  async function alphaDecision(action: 'confirm' | 'open') {
    const promptText =
      action === 'confirm'
        ? '请填写人工确认放量检查的依据'
        : '请填写开放下一批 Alpha 的原因';
    const reason = window.prompt(promptText);
    if (!reason?.trim()) return;
    await adminApi(
      action === 'confirm'
        ? '/api/admin/alpha/readiness/confirm'
        : '/api/admin/alpha/next-batch/open',
      { method: 'POST', body: JSON.stringify({ reason }) }
    );
    await reload();
  }

  return (
    <>
      <div className="admin-page-heading">
        <div>
          <p className="admin-kicker">Capacity control</p>
          <h1>Alpha</h1>
          <p>资格、支持者身份和套餐互相独立；支持者只影响候补优先级。</p>
        </div>
      </div>
      <Panel title="席位与批次">
        <MetricGrid data={{ ...plan, ...seats }} />
        <div className="alpha-decision-actions">
          <div>
            <strong>第二批放量检查</strong>
            <span>
              {readiness.can_unlock
                ? '自动检查与人工确认均已满足'
                : `${String(
                    ((readiness.blocking_reasons ?? []) as unknown[]).length
                  )} 项待处理`}
            </span>
          </div>
          <button onClick={() => void alphaDecision('confirm')}>人工确认</button>
          <button
            className="admin-primary"
            disabled={Number(plan.batch_2_capacity ?? 0) <= 0}
            onClick={() => void alphaDecision('open')}
          >
            开放下一批
          </button>
        </div>
      </Panel>
      <Panel title="候补列表" description="按服务端优先级排序，管理员决定是否释放。">
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>顺序</th>
                <th>用户 ID</th>
                <th>加入时间</th>
                <th>支持者</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {waitlist.map((row) => (
                <tr key={String(row.userId)}>
                  <td>{String(row.rank)}</td>
                  <td className="mono">{String(row.userId)}</td>
                  <td>{displayValue('', row.joinedAt)}</td>
                  <td>{row.foundingSupporter ? '是' : '否'}</td>
                  <td>
                    <button
                      className="admin-table-action"
                      onClick={() => void release(String(row.userId))}
                    >
                      分配资格
                    </button>
                  </td>
                </tr>
              ))}
              {waitlist.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-cell">
                    当前没有候补用户
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function UsersModule({
  data,
  reload
}: {
  data: JsonRecord;
  reload: () => Promise<void>;
}) {
  const users = (data.users ?? []) as JsonRecord[];
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<JsonRecord | null>(null);
  const visible = useMemo(
    () =>
      users.filter((user) =>
        `${String(user.user_id)} ${String(user.email ?? '')}`
          .toLowerCase()
          .includes(query.toLowerCase())
      ),
    [query, users]
  );

  async function setStatus(userId: string, status: 'ACTIVE' | 'DISABLED') {
    const reason = window.prompt(status === 'DISABLED' ? '暂停账号原因' : '恢复账号原因');
    if (!reason?.trim()) return;
    await adminApi(`/api/admin/users/${userId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, reason })
    });
    await reload();
  }

  async function adjust(userId: string) {
    const raw = window.prompt('额度调整数量（可为负数）');
    if (!raw) return;
    const delta = Number(raw);
    if (!Number.isInteger(delta) || delta === 0) return;
    const reason = window.prompt('额度调整原因');
    if (!reason?.trim()) return;
    await adminApi(`/api/admin/users/${userId}/quota-adjustments`, {
      method: 'POST',
      body: JSON.stringify({ delta, reason })
    });
    await reload();
  }

  async function changeAlpha(
    userId: string,
    transition: 'PAUSE' | 'RESUME' | 'END'
  ) {
    const reason = window.prompt('请填写 Alpha 资格变更原因');
    if (!reason?.trim()) return;
    await adminApi(`/api/admin/alpha/members/${userId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ transition, reason })
    });
    await reload();
  }

  async function reviewClaim(claimId: string, decision: 'APPROVE' | 'REJECT') {
    const reason = window.prompt(
      decision === 'APPROVE' ? '请填写通过认领的核验依据' : '请填写拒绝认领的原因'
    );
    if (!reason?.trim()) return;
    await adminApi(`/api/admin/supporter-claims/${claimId}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, review_note: reason, reason })
    });
    await reload();
  }

  async function openUser(userId: string) {
    const result = await adminApi<{ user: JsonRecord }>(
      `/api/admin/users/${userId}`
    );
    setSelected(result.user);
  }

  return (
    <>
      <div className="admin-page-heading">
        <div>
          <p className="admin-kicker">Identity continuity</p>
          <h1>用户</h1>
          <p>匿名升级后沿用同一 user_id；不显示聊天正文或真实 API Key。</p>
        </div>
        <label className="admin-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 ID 或邮箱"
          />
        </label>
      </div>
      <Panel title={`用户列表 · ${String(data.total ?? users.length)}`}>
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>用户</th>
                <th>账号</th>
                <th>Alpha</th>
                <th>支持者</th>
                <th>核心闭环</th>
                <th>额度 / BYOK</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((user) => (
                <tr key={String(user.user_id)}>
                  <td>
                    <strong>{user.registered ? String(user.email ?? '已注册') : '匿名用户'}</strong>
                    <small className="mono">{String(user.user_id)}</small>
                  </td>
                  <td>
                    <span className={`status ${user.status === 'ACTIVE' ? 'good' : 'bad'}`}>
                      {String(user.status)}
                    </span>
                  </td>
                  <td>{String(user.alpha_status ?? '—')}</td>
                  <td>{user.founding_supporter ? '是' : '否'}</td>
                  <td>{user.completed_core_loop ? '已完成' : '未完成'}</td>
                  <td>
                    {user.used_platform_quota ? '平台' : '—'} /{' '}
                    {user.byok_configured ? '已配置' : '未配置'}
                  </td>
                  <td className="row-actions">
                    <button onClick={() => void openUser(String(user.user_id))}>
                      详情
                    </button>
                    <button onClick={() => void adjust(String(user.user_id))}>调额度</button>
                    <button
                      onClick={() =>
                        void setStatus(
                          String(user.user_id),
                          user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'
                        )
                      }
                    >
                      {user.status === 'ACTIVE' ? '暂停' : '恢复'}
                    </button>
                    {['ALPHA_ACTIVE', 'ALPHA_GRANTED'].includes(
                      String(user.alpha_status)
                    ) && (
                      <button
                        onClick={() =>
                          void changeAlpha(String(user.user_id), 'PAUSE')
                        }
                      >
                        暂停 Alpha
                      </button>
                    )}
                    {user.alpha_status === 'ALPHA_PAUSED' && (
                      <button
                        onClick={() =>
                          void changeAlpha(String(user.user_id), 'RESUME')
                        }
                      >
                        恢复 Alpha
                      </button>
                    )}
                    {['ALPHA_ACTIVE', 'ALPHA_GRANTED', 'ALPHA_PAUSED'].includes(
                      String(user.alpha_status)
                    ) && (
                      <button
                        onClick={() =>
                          void changeAlpha(String(user.user_id), 'END')
                        }
                      >
                        撤销 Alpha
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Founding Supporter 认领审核">
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>申请</th>
                <th>昵称</th>
                <th>金额</th>
                <th>时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {((data.claims ?? []) as JsonRecord[]).map((claim) => (
                <tr key={String(claim.claim_id)}>
                  <td className="mono">{String(claim.claim_id)}</td>
                  <td>{String(claim.nickname)}</td>
                  <td>{String(claim.amount)}</td>
                  <td>{String(claim.paid_at)}</td>
                  <td className="row-actions">
                    <button
                      onClick={() =>
                        void reviewClaim(String(claim.claim_id), 'APPROVE')
                      }
                    >
                      通过
                    </button>
                    <button
                      onClick={() =>
                        void reviewClaim(String(claim.claim_id), 'REJECT')
                      }
                    >
                      拒绝
                    </button>
                  </td>
                </tr>
              ))}
              {((data.claims ?? []) as unknown[]).length === 0 && (
                <tr>
                  <td className="empty-cell" colSpan={5}>
                    没有待审核认领
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      {selected && (
        <div className="user-detail-backdrop" onClick={() => setSelected(null)}>
          <aside className="user-detail" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <span>用户详情</span>
                <h2>{String(selected.email ?? '匿名用户')}</h2>
                <code>{String(selected.user_id)}</code>
              </div>
              <button onClick={() => setSelected(null)}>关闭</button>
            </header>
            <MetricGrid
              data={{
                status: selected.status,
                plan: selected.plan,
                alpha_status: selected.alpha_status,
                founding_supporter: selected.founding_supporter,
                character_count: selected.character_count,
                conversation_count: selected.conversation_count,
                message_count: selected.message_count,
                successful_generations: selected.successful_generations,
                has_effective_session: selected.has_effective_session,
                has_memory: selected.has_memory,
                same_character_revisit: selected.same_character_revisit,
                memory_recalled: selected.memory_recalled,
                total_tokens: selected.total_tokens,
                estimated_cost_usd: selected.estimated_cost_usd,
                byok_configured: selected.byok_configured
              }}
            />
            <div className="user-detail-section">
              <h3>时间与来源</h3>
              <dl>
                <div><dt>匿名创建</dt><dd>{String(selected.anonymous_created_at)}</dd></div>
                <div><dt>注册时间</dt><dd>{String(selected.registered_at ?? '—')}</dd></div>
                <div><dt>首次来源</dt><dd>{String(selected.first_source)}</dd></div>
                <div><dt>最近活跃</dt><dd>{String(selected.last_active_at ?? '—')}</dd></div>
              </dl>
            </div>
            <div className="user-detail-section">
              <h3>Provider / 模型分布</h3>
              <pre>
                {JSON.stringify(selected.provider_model_distribution ?? [], null, 2)}
              </pre>
            </div>
            <div className="user-detail-section">
              <h3>相关反馈与生成错误</h3>
              <pre>
                {JSON.stringify(
                  {
                    feedback: selected.feedback ?? [],
                    generation_errors: selected.generation_errors ?? []
                  },
                  null,
                  2
                )}
              </pre>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

function FeedbackModule({
  data,
  reload
}: {
  data: JsonRecord;
  reload: () => Promise<void>;
}) {
  const feedback = (data.feedback ?? []) as JsonRecord[];
  async function update(id: string, patch: JsonRecord) {
    const reason = window.prompt('请填写本次反馈状态变更原因');
    if (!reason?.trim()) return;
    await adminApi(`/api/admin/feedback/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, reason })
    });
    await reload();
  }
  async function note(id: string, field: 'internal_note' | 'github_issue_url') {
    const value = window.prompt(
      field === 'internal_note' ? '填写内部备注' : '填写 GitHub Issue HTTPS 链接'
    );
    if (value === null) return;
    await update(id, { [field]: value || null });
  }
  return (
    <>
      <div className="admin-page-heading">
        <div>
          <p className="admin-kicker">Product signal</p>
          <h1>反馈</h1>
          <p>极简分诊队列，不包含指派、SLA、邮件或自动 GitHub 同步。</p>
        </div>
      </div>
      <Panel title="反馈列表">
        <div className="feedback-list">
          {feedback.map((item) => (
            <article key={String(item.feedback_id)}>
              <header>
                <div>
                  <span className={`priority priority-${String(item.priority).toLowerCase()}`}>
                    {String(item.priority)}
                  </span>
                  <strong>{String(item.type)}</strong>
                </div>
                <time>{new Date(String(item.created_at)).toLocaleString('zh-CN')}</time>
              </header>
              <p>{String(item.content)}</p>
              <dl>
                <div>
                  <dt>页面</dt>
                  <dd>{String(item.page_path ?? '—')}</dd>
                </div>
                <div>
                  <dt>Provider / 模型</dt>
                  <dd>{`${String(item.provider ?? '—')} / ${String(item.model ?? '—')}`}</dd>
                </div>
                <div>
                  <dt>Trace</dt>
                  <dd className="mono">{String(item.trace_id ?? '—')}</dd>
                </div>
              </dl>
              <footer>
                <select
                  value={String(item.status)}
                  onChange={(event) =>
                    void update(String(item.feedback_id), {
                      status: event.target.value
                    })
                  }
                >
                  {['NEW', 'TRIAGED', 'PLANNED', 'RESOLVED', 'WONT_FIX'].map(
                    (status) => (
                      <option key={status}>{status}</option>
                    )
                  )}
                </select>
                <select
                  value={String(item.priority)}
                  onChange={(event) =>
                    void update(String(item.feedback_id), {
                      priority: event.target.value
                    })
                  }
                >
                  {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((priority) => (
                    <option key={priority}>{priority}</option>
                  ))}
                </select>
                <select
                  value={String(item.category ?? '')}
                  onChange={(event) =>
                    void update(String(item.feedback_id), {
                      category: event.target.value || null
                    })
                  }
                >
                  <option value="">未分类</option>
                  {[
                    'BUG',
                    'UX',
                    'PERFORMANCE',
                    'CONTENT_QUALITY',
                    'BILLING_QUOTA',
                    'FEATURE_REQUEST',
                    'OTHER'
                  ].map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </select>
                <button onClick={() => void note(String(item.feedback_id), 'internal_note')}>
                  内部备注
                </button>
                <button onClick={() => void note(String(item.feedback_id), 'github_issue_url')}>
                  关联 Issue
                </button>
                {item.github_issue_url ? (
                  <a href={String(item.github_issue_url)} target="_blank" rel="noreferrer">
                    GitHub Issue
                  </a>
                ) : null}
              </footer>
            </article>
          ))}
          {feedback.length === 0 && <p className="admin-empty">当前没有反馈</p>}
        </div>
      </Panel>
    </>
  );
}

function AnalyticsModule({ data }: { data: JsonRecord }) {
  const overview = (data.overview ?? {}) as JsonRecord;
  return (
    <>
      <div className="admin-page-heading">
        <div>
          <p className="admin-kicker">Product validation</p>
          <h1>数据分析</h1>
          <p>漏斗和留存由消息、生成与记忆业务数据计算，不接受前端“完成”事件。</p>
        </div>
      </div>
      <Panel title="获客与激活">
        <MetricGrid
          data={{
            ...((data.acquisition ?? {}) as JsonRecord),
            ...((overview.newUsers ?? {}) as JsonRecord),
            ...((overview.activation ?? {}) as JsonRecord)
          }}
        />
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>来源 / 媒介 / Campaign</th>
                <th>用户</th>
                <th>注册率</th>
                <th>激活率</th>
                <th>闭环率</th>
                <th>激活用户均摊成本</th>
              </tr>
            </thead>
            <tbody>
              {((data.channels ?? []) as JsonRecord[]).map((channel, index) => (
                <tr key={`${String(channel.source)}-${String(channel.medium)}-${index}`}>
                  <td>{`${String(channel.source)} / ${String(channel.medium || '—')} / ${String(channel.campaign || '—')}`}</td>
                  <td>{String(channel.users)}</td>
                  <td>{displayValue('rate', channel.registration_rate)}</td>
                  <td>{displayValue('rate', channel.activation_rate)}</td>
                  <td>{displayValue('rate', channel.core_loop_rate)}</td>
                  <td>{displayValue('usd', channel.average_cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="核心体验漏斗">
        <MetricGrid data={(data.funnel ?? {}) as JsonRecord} />
      </Panel>
      <Panel title="留存与关系持续性">
        <MetricGrid
          data={{
            ...((overview.retention ?? {}) as JsonRecord),
            ...((data.relationship_continuity ?? {}) as JsonRecord)
          }}
        />
      </Panel>
      <Panel title="页面深度与退出">
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>页面</th>
                <th>进入 Session</th>
                <th>退出 Session</th>
                <th>下一页转化率</th>
              </tr>
            </thead>
            <tbody>
              {((overview.pages ?? []) as JsonRecord[]).map((page) => (
                <tr key={String(page.pageName)}>
                  <td>{String(page.pageName)}</td>
                  <td>{String(page.enteredSessions)}</td>
                  <td>{String(page.exitedSessions)}</td>
                  <td>{displayValue('rate', page.nextCorePageConversionRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="支持与商业验证">
        <div className="support-metrics">
          {((data.support ?? []) as JsonRecord[]).map((row) => (
            <div key={String(row.event_name)}>
              <span>{String(row.event_name)}</span>
              <strong>{String(row.users)}</strong>
            </div>
          ))}
        </div>
        <MetricGrid data={(data.support_segments ?? {}) as JsonRecord} />
      </Panel>
    </>
  );
}

function SystemModule({
  data,
  reload
}: {
  data: JsonRecord;
  reload: () => Promise<void>;
}) {
  const [providers, setProviders] = useState<JsonRecord[]>([]);
  useEffect(() => setProviders((data.providers ?? []) as JsonRecord[]), [data]);

  function update(index: number, patch: JsonRecord) {
    setProviders((current) =>
      current.map((provider, currentIndex) =>
        currentIndex === index ? { ...provider, ...patch } : provider
      )
    );
  }

  async function save() {
    const reason = window.prompt('请填写 Provider 策略调整原因');
    if (!reason?.trim()) return;
    await adminApi('/api/admin/system/providers', {
      method: 'PUT',
      body: JSON.stringify({
        providers: providers.map((provider, index) => ({
          provider: provider.provider,
          enabled: provider.enabled,
          fallback_order: index + 1
        })),
        reason
      })
    });
    await reload();
  }

  return (
    <>
      <div className="admin-page-heading">
        <div>
          <p className="admin-kicker">Runtime health</p>
          <h1>系统</h1>
          <p>只管理启停和回退顺序；密钥与复杂 Prompt 仍由服务端环境管理。</p>
        </div>
        <button className="admin-primary" onClick={() => void save()}>
          保存顺序
        </button>
      </div>
      <Panel title="Provider 与运行状态">
        <div className="provider-list">
          {providers.map((provider, index) => (
            <article key={String(provider.provider)}>
              <div className="provider-rank">{index + 1}</div>
              <div className="provider-name">
                <strong>{String(provider.provider)}</strong>
                <span>{provider.enabled ? '已启用' : '已停用'}</span>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={Boolean(provider.enabled)}
                  onChange={(event) => update(index, { enabled: event.target.checked })}
                />
                <span />
              </label>
              <div className="provider-stats">
                <span>请求 {String(provider.requests ?? 0)}</span>
                <span>成功率 {displayValue('rate', provider.success_rate)}</span>
                <span>P95 {String(provider.p95_latency_ms ?? 0)} ms</span>
                <span>Token {String(Number(provider.input_tokens ?? 0) + Number(provider.output_tokens ?? 0))}</span>
                <span>成本 {displayValue('usd', provider.estimated_cost_usd)}</span>
              </div>
              <div className="provider-order">
                <button
                  disabled={index === 0}
                  onClick={() =>
                    setProviders((current) => {
                      const next = [...current];
                      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                      return next;
                    })
                  }
                >
                  上移
                </button>
                <button
                  disabled={index === providers.length - 1}
                  onClick={() =>
                    setProviders((current) => {
                      const next = [...current];
                      [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                      return next;
                    })
                  }
                >
                  下移
                </button>
              </div>
            </article>
          ))}
        </div>
      </Panel>
    </>
  );
}

export default function AdminApp() {
  const [authenticated, setAuthenticated] = useState(readAdminToken().length > 0);
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<JsonRecord>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true);
    setError('');
    try {
      const payload =
        tab === 'overview'
          ? await adminApi<JsonRecord>('/api/admin/overview')
          : tab === 'alpha'
            ? await Promise.all([
                adminApi<JsonRecord>('/api/admin/alpha'),
                adminApi<JsonRecord>('/api/admin/alpha/waitlist')
              ]).then(([alpha, waitlist]) => ({ ...alpha, ...waitlist }))
            : tab === 'users'
              ? await Promise.all([
                  adminApi<JsonRecord>('/api/admin/users?limit=100'),
                  adminApi<JsonRecord>(
                    '/api/admin/supporter-claims?status=PENDING&limit=100'
                  )
                ]).then(([users, claims]) => ({ ...users, ...claims }))
              : tab === 'feedback'
                ? await adminApi<JsonRecord>('/api/admin/feedback?limit=100')
                : tab === 'analytics'
                  ? await adminApi<JsonRecord>('/api/admin/analytics')
                  : await adminApi<JsonRecord>('/api/admin/system/providers');
      setData(payload);
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 401) {
        saveAdminToken('');
        setAuthenticated(false);
      } else {
        setError(caught instanceof Error ? caught.message : '加载失败');
      }
    } finally {
      setLoading(false);
    }
  }, [authenticated, tab]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;

  return (
    <main className="admin-shell">
      <aside>
        <a className="admin-brand" href="/">
          <ShieldCheck size={22} />
          <span>
            <strong>LiteTavern</strong>
            <small>ADMIN · v0.1.0</small>
          </span>
        </a>
        <nav aria-label="后台模块">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? 'active' : ''}
              onClick={() => setTab(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
        <div className="admin-aside-footer">
          <span>
            <i />
            Cloud API
          </span>
          <button
            onClick={() => {
              saveAdminToken('');
              setAuthenticated(false);
            }}
          >
            <LogOut size={16} />
            退出
          </button>
        </div>
      </aside>
      <section className="admin-content">
        <div className="admin-toolbar">
          <span>
            <Activity size={15} />
            数据来自权威业务表
          </span>
          <button onClick={() => void load()} disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            刷新
          </button>
        </div>
        {error && (
          <div className="admin-alert">
            <CircleAlert size={18} />
            {error}
          </div>
        )}
        {loading && Object.keys(data).length === 0 ? (
          <div className="admin-loading">正在读取决策数据…</div>
        ) : (
          <>
            {tab === 'overview' && <Overview data={data} />}
            {tab === 'alpha' && <AlphaModule data={data} reload={load} />}
            {tab === 'users' && <UsersModule data={data} reload={load} />}
            {tab === 'feedback' && <FeedbackModule data={data} reload={load} />}
            {tab === 'analytics' && <AnalyticsModule data={data} />}
            {tab === 'system' && <SystemModule data={data} reload={load} />}
          </>
        )}
      </section>
    </main>
  );
}
