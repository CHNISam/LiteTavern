import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Check, ChevronLeft, ExternalLink, KeyRound, LoaderCircle, Plus, Trash2, X } from 'lucide-react';
import { api, type ModelConfiguration, type Provider } from '../lib/api';
import { credentialStore, type CredentialSummary } from '../lib/credential-store';
import { createId } from '../lib/id';

interface ProviderSettingsProps {
  open: boolean;
  onClose: () => void;
  onConfigurationsChanged: (configurations: ModelConfiguration[]) => void;
}

export function ProviderSettings({ open, onClose, onConfigurationsChanged }: ProviderSettingsProps) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [configurations, setConfigurations] = useState<ModelConfiguration[]>([]);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [selected, setSelected] = useState<Provider | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function refresh() {
    const [providerResponse, configurationResponse, localCredentials] = await Promise.all([
      api<{ providers: Provider[] }>('/v1/providers'),
      api<{ configurations: ModelConfiguration[] }>('/v1/model-configurations'),
      credentialStore.list()
    ]);
    setProviders(providerResponse.providers);
    setConfigurations(configurationResponse.configurations);
    setCredentials(localCredentials);
    onConfigurationsChanged(configurationResponse.configurations);
  }

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  const grouped = useMemo(
    () => ({
      CN: providers.filter((provider) => provider.region === 'CN'),
      GLOBAL: providers.filter((provider) => provider.region === 'GLOBAL'),
      LOCAL: providers.filter((provider) => provider.region === 'LOCAL'),
      CUSTOM: providers.filter((provider) => provider.region === 'CUSTOM')
    }),
    [providers]
  );

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

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-panel" role="dialog" aria-modal="true" aria-label="模型与 API Key" onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div>
            <span className="eyebrow">模型连接</span>
            <h2>{selected ? selected.name : '选择服务商'}</h2>
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
            {configurations.length > 0 && <section><h3>已连接</h3><div className="connected-list">{configurations.map((configuration) => {
              const local = credentials.find((item) => item.credentialId === configuration.credential_id);
              return <article className="connected-card" key={configuration.model_configuration_id}><div><strong>{configuration.display_name}</strong><span>{configuration.model_name}</span><small>{local?.maskedKey ?? '本浏览器未找到 Key'}</small></div><div className="row-actions"><button onClick={() => void replaceKey(configuration)}>更换 Key</button><button className="danger-icon" aria-label="删除配置" onClick={() => void remove(configuration)}><Trash2 size={16} /></button></div></article>;
            })}</div></section>}
            {([['CN', '国内服务商'], ['GLOBAL', '国际服务商'], ['LOCAL', '本地模型'], ['CUSTOM', '自定义厂商']] as const).map(([region, title]) => <section key={region}><h3>{title}</h3><div className="provider-grid">{grouped[region].map((provider) => <button className="provider-card" key={provider.id} onClick={() => choose(provider)}><span className="provider-mark">{provider.shortName.slice(0, 1)}</span><span><strong>{provider.shortName}</strong><small>{provider.id === 'custom-openai' ? '任意 OpenAI-compatible 服务' : provider.baseUrl.replace(/^https?:\/\//, '')}</small></span><Plus size={17} /></button>)}</div></section>)}
          </div>
        )}
      </section>
    </div>
  );
}
