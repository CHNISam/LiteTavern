import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronLeft, ExternalLink, KeyRound, LoaderCircle, Plus, Search, Trash2, X } from 'lucide-react';
import { api, type ModelConfiguration, type Provider } from '../lib/api';
import { CLOUD_PROVIDER_NAME, describeQuota, type CloudStatus } from '../lib/cloud';
import { credentialStore, type CredentialSummary } from '../lib/credential-store';
import { createId } from '../lib/id';

interface ProviderSettingsProps {
  open: boolean;
  onClose: () => void;
  onConfigurationsChanged: (configurations: ModelConfiguration[]) => void;
  cloud?: CloudStatus | null;
  freeQuotaEnabled?: boolean;
  usageMode?: 'PLATFORM' | 'BYOK';
  initialSection?: 'overview' | 'platform' | 'byok';
  onUsageMode?: (mode: 'PLATFORM' | 'BYOK') => void;
  /** True when the shown Cloud status is the cached copy, not a live answer. */
  offline?: boolean;
}

function percent(ratio: number): number {
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

export function ProviderSettings({
  open,
  onClose,
  onConfigurationsChanged,
  cloud = null,
  freeQuotaEnabled = true,
  usageMode = 'PLATFORM',
  initialSection = 'overview',
  onUsageMode,
  offline = false
}: ProviderSettingsProps) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [configurations, setConfigurations] = useState<ModelConfiguration[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [selected, setSelected] = useState<Provider | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setLoadError(null);
    try {
      const [providerResponse, configurationResponse, localCredentials] = await Promise.all([
        api<{ providers: Provider[] }>('/v1/providers'),
        api<{ configurations: ModelConfiguration[] }>('/v1/model-configurations'),
        credentialStore.list()
      ]);
      if (providerResponse.providers.length === 0) {
        throw new Error('服务商目录为空，请检查 LiteTavern Cloud 配置。');
      }
      setProviders(providerResponse.providers);
      setConfigurations(configurationResponse.configurations);
      setCredentials(localCredentials);
      onConfigurationsChanged(configurationResponse.configurations);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? `无法加载服务商：${error.message}`
          : '无法加载服务商，请稍后重试。'
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  const REGIONS = [
    ['CN', '国内服务商'],
    ['GLOBAL', '国际服务商'],
    ['LOCAL', '本地模型'],
    ['CUSTOM', '自定义厂商']
  ] as const;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (provider: Provider) =>
      !needle ||
      `${provider.name} ${provider.shortName} ${provider.baseUrl}`.toLowerCase().includes(needle);
    return {
      CN: providers.filter((item) => item.region === 'CN' && matches(item)),
      GLOBAL: providers.filter((item) => item.region === 'GLOBAL' && matches(item)),
      LOCAL: providers.filter((item) => item.region === 'LOCAL' && matches(item)),
      CUSTOM: providers.filter((item) => item.region === 'CUSTOM' && matches(item))
    };
  }, [providers, query]);

  const visibleRegions = REGIONS.filter(([region]) => filtered[region].length > 0);

  function choose(provider: Provider) {
    setSelected(provider);
    setBaseUrl(provider.baseUrl);
    setModel(provider.placeholderModels[0] ?? '');
    setLabel(provider.shortName);
    setApiKey('');
    setStatus(null);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected || !model || (selected.apiKeyRequired && !apiKey)) return;
    setBusy(true);
    setStatus('正在验证连接…');
    try {
      const credentialId = createId();
      const validation = await api<{ ok: boolean; models: string[] }>(
        '/v1/provider-connections/validate',
        {
          method: 'POST',
          body: JSON.stringify({
            provider: selected.id,
            base_url: baseUrl,
            model,
            credential: { credential_id: credentialId, api_key: apiKey || 'local-no-key' }
          })
        }
      );
      if (!validation.ok) throw new Error('连接验证失败。');
      const local = await credentialStore.save({
        provider: selected.id,
        label: label || selected.shortName,
        apiKey: apiKey || 'local-no-key'
      });
      try {
        await api('/v1/model-configurations', {
          method: 'POST',
          body: JSON.stringify({
            provider: selected.id,
            display_name: label || selected.shortName,
            model_name: model,
            base_url: baseUrl,
            credential_id: local.credentialId
          })
        });
      } catch (error) {
        await credentialStore.remove(local.credentialId);
        throw error;
      }
      setApiKey('');
      setStatus('连接成功，配置已保存到当前浏览器。');
      await refresh();
      setTimeout(() => setSelected(null), 500);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '连接失败。');
    } finally {
      setBusy(false);
    }
  }

  async function remove(configuration: ModelConfiguration) {
    await Promise.all([
      credentialStore.remove(configuration.credential_id),
      api(`/v1/model-configurations/${configuration.model_configuration_id}`, { method: 'DELETE' })
    ]);
    await refresh();
  }

  async function replaceKey(configuration: ModelConfiguration) {
    const next = window.prompt('输入新的 API Key（保存后仍只显示掩码）');
    if (!next) return;
    await credentialStore.update(configuration.credential_id, next);
    await refresh();
  }

  const quotaDescription = describeQuota(cloud);
  const platformUsable =
    freeQuotaEnabled &&
    cloud?.platform_models_available !== false &&
    Boolean(quotaDescription) &&
    !quotaDescription!.exhausted;

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-panel" role="dialog" aria-modal="true" aria-label="模型服务" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div>
            <span className="eyebrow">模型服务</span>
            <h2>{selected ? selected.name : '选择由谁来生成回复'}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button>
        </header>

        {selected ? (
          <form className="provider-form" onSubmit={save}>
            <button type="button" className="back-link" onClick={() => setSelected(null)}><ChevronLeft size={16} /> 返回服务商</button>
            <label>配置名称<input value={label} onChange={(event) => setLabel(event.target.value)} required /></label>
            <label>Base URL<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={!selected.allowCustomBaseUrl} required={selected.id === 'custom-openai'} placeholder="https://example.com/v1" /></label>
            <label>模型 ID<input value={model} onChange={(event) => setModel(event.target.value)} required placeholder="从服务商模型页复制" /></label>
            <label>API Key<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required={selected.apiKeyRequired} placeholder={selected.apiKeyRequired ? '仅保存在当前浏览器' : '本地服务可留空'} /></label>
            <p className="privacy-note"><KeyRound size={16} /> 完整 Key 写入当前浏览器 IndexedDB；服务端仅在验证与生成时临时转发。</p>
            {selected.notice && <p className="provider-notice">{selected.notice}</p>}
            {selected.helpUrl && <a className="docs-link" href={selected.helpUrl} target="_blank" rel="noreferrer">查看服务商文档 <ExternalLink size={14} /></a>}
            {status && <p className="form-status" role="status">{status}</p>}
            <button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} 验证并保存</button>
          </form>
        ) : (
          <div className="provider-content">
            <section className="model-service-overview" aria-label="模型服务状态">
              {/* The allowance is named, metered and sourced. It used to be one
                  bare number, which read as invented — and it never said which
                  service was paying for it. */}
              <article
                className={`service-card ${initialSection === 'platform' ? 'is-focused' : ''}`}
              >
                <div className="service-card-head">
                  <span className="service-mark">LT</span>
                  <div>
                    <h3>{CLOUD_PROVIDER_NAME}</h3>
                    <small>由 LiteTavern 运营的托管模型服务</small>
                  </div>
                  {usageMode === 'PLATFORM' && platformUsable && (
                    <span className="service-badge">使用中</span>
                  )}
                </div>

                {!platformUsable ? (
                  <p className="service-unavailable">
                    {quotaDescription?.exhausted
                      ? `${quotaDescription.poolName}已用完，${quotaDescription.renewal}。`
                      : `${CLOUD_PROVIDER_NAME} 平台模型当前不可用。`}
                    你可以在下方接入自己的模型继续聊天。
                  </p>
                ) : quotaDescription ? (
                  <div className="quota-readout">
                    <div className="quota-figure">
                      <strong>{quotaDescription.available}</strong>
                      <span>
                        / {quotaDescription.total} {quotaDescription.unitName}剩余
                      </span>
                    </div>
                    <div
                      className="quota-meter"
                      role="meter"
                      aria-valuemin={0}
                      aria-valuemax={quotaDescription.total}
                      aria-valuenow={quotaDescription.available}
                      aria-label={`${quotaDescription.poolName}剩余量`}
                    >
                      <i style={{ width: `${percent(quotaDescription.ratio)}%` }} />
                    </div>
                    <dl className="quota-facts">
                      <div>
                        <dt>额度来源</dt>
                        <dd>{quotaDescription.poolName}</dd>
                      </div>
                      <div>
                        <dt>已用</dt>
                        <dd>
                          {quotaDescription.used} {quotaDescription.unitName}
                        </dd>
                      </div>
                      <div>
                        <dt>恢复方式</dt>
                        <dd>{quotaDescription.renewal}</dd>
                      </div>
                    </dl>
                    {offline && (
                      <p className="quota-stale" role="status">
                        {CLOUD_PROVIDER_NAME} 暂时无法连接，以上是最后一次同步到的数据。
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="service-unavailable">
                    这个账号还没有 {CLOUD_PROVIDER_NAME} 平台额度。
                  </p>
                )}

                <button
                  type="button"
                  disabled={!platformUsable}
                  aria-pressed={usageMode === 'PLATFORM'}
                  onClick={() => onUsageMode?.('PLATFORM')}
                >
                  {usageMode === 'PLATFORM' ? '正在使用此服务' : `使用 ${CLOUD_PROVIDER_NAME}`}
                </button>
              </article>

              <article
                className={`service-card ${initialSection === 'byok' ? 'is-focused' : ''}`}
              >
                <div className="service-card-head">
                  <span className="service-mark service-mark-byok"><KeyRound size={17} /></span>
                  <div>
                    <h3>自己的模型</h3>
                    <small>用你自己的 API Key，费用与额度由服务商结算</small>
                  </div>
                  {usageMode === 'BYOK' && configurations.length > 0 && (
                    <span className="service-badge">使用中</span>
                  )}
                </div>

                {configurations.length > 0 ? (
                  <dl className="quota-facts">
                    <div>
                      <dt>已连接</dt>
                      <dd>{configurations.length} 个配置</dd>
                    </div>
                    <div>
                      <dt>当前</dt>
                      <dd>{configurations[0]!.display_name}</dd>
                    </div>
                    <div>
                      <dt>Key 保存位置</dt>
                      <dd>仅当前浏览器</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="service-unavailable">
                    还没有接入任何服务商。从下方选择一个开始，API Key 只保存在这台设备上。
                  </p>
                )}

                {configurations.length > 0 && (
                  <button
                    type="button"
                    aria-pressed={usageMode === 'BYOK'}
                    onClick={() => onUsageMode?.('BYOK')}
                  >
                    {usageMode === 'BYOK' ? '正在使用此服务' : '使用自己的模型'}
                  </button>
                )}
              </article>
            </section>
            {loading ? (
              <div className="provider-empty-state" role="status">
                <LoaderCircle className="spin" size={24} />
                <strong>正在加载服务商…</strong>
              </div>
            ) : loadError ? (
              <div className="provider-empty-state provider-load-error" role="alert">
                <strong>{loadError}</strong>
                <span>API Key 不受影响，仍只保存在当前浏览器。</span>
                <button className="secondary-button" type="button" onClick={() => void refresh()}>
                  重新加载
                </button>
              </div>
            ) : (
              <>
            {configurations.length > 0 && <section><h3>已连接</h3><div className="connected-list">{configurations.map((configuration) => {
              const local = credentials.find((item) => item.credentialId === configuration.credential_id);
              return <article className="connected-card" key={configuration.model_configuration_id}><div><strong>{configuration.display_name}</strong><span>{configuration.model_name}</span><small>{local?.maskedKey ?? '本浏览器未找到 Key'}</small></div><div className="row-actions"><button onClick={() => void replaceKey(configuration)}>更换 Key</button><button className="danger-icon" aria-label="删除配置" onClick={() => void remove(configuration)}><Trash2 size={16} /></button></div></article>;
            })}</div></section>}

            <div className="provider-search">
              <Search size={15} />
              <input
                type="search"
                aria-label="搜索服务商"
                placeholder="搜索服务商或地址"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {visibleRegions.length === 0 ? (
              <p className="provider-no-match" role="status">没有匹配「{query}」的服务商。</p>
            ) : (
              visibleRegions.map(([region, title]) => (
                <section key={region}>
                  <h3>{title}</h3>
                  <div className="provider-grid">
                    {filtered[region].map((provider) => {
                      // Connecting a second key to the same provider is legitimate,
                      // so this marks the row rather than disabling it.
                      const connected = configurations.some((item) => item.provider === provider.id);
                      return (
                        <button className="provider-card" key={provider.id} onClick={() => choose(provider)}>
                          <span className="provider-mark">{provider.shortName.slice(0, 1)}</span>
                          <span>
                            <strong>{provider.shortName}</strong>
                            <small>{provider.id === 'custom-openai' ? '任意 OpenAI-compatible 服务' : provider.baseUrl.replace(/^https?:\/\//, '')}</small>
                          </span>
                          {connected ? <span className="provider-connected">已连接</span> : <Plus size={17} />}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))
            )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
