import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronLeft, ExternalLink, KeyRound, LoaderCircle, Plus, Search, Trash2, X } from 'lucide-react';
import { api, type ModelConfiguration, type Provider } from '../lib/api';
import {
  cloudProviderName,
  describeQuotaWindows,
  resolveCloudModelServiceState,
  resolveCloudNotice,
  type CloudModelServiceState,
  type CloudStatus
} from '../lib/cloud';
import { useLocale } from '../lib/i18n';
import { credentialStore, type CredentialSummary } from '../lib/credential-store';
import { createId } from '../lib/id';

interface ProviderSettingsProps {
  open: boolean;
  onClose: () => void;
  onConfigurationsChanged: (configurations: ModelConfiguration[]) => void;
  cloud?: CloudStatus | null;
  cloudService?: CloudModelServiceState;
  usageMode?: 'PLATFORM' | 'BYOK';
  initialSection?: 'overview' | 'platform' | 'byok';
  onUsageMode?: (mode: 'PLATFORM' | 'BYOK') => void;
  /** True when the shown Cloud status is the cached copy, not a live answer. */
  offline?: boolean;
  onRetryCloud?: () => void;
}

function percent(ratio: number): number {
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

export function ProviderSettings({
  open,
  onClose,
  onConfigurationsChanged,
  cloud = null,
  cloudService,
  usageMode = 'PLATFORM',
  initialSection = 'overview',
  onUsageMode,
  offline = false,
  onRetryCloud
}: ProviderSettingsProps) {
  const { locale, dictionary: t } = useLocale();
  const cloudName = cloudProviderName();
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
  const providerSearchRef = useRef<HTMLInputElement>(null);

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
        throw new Error(t.models.emptyCatalogue);
      }
      setProviders(providerResponse.providers);
      setConfigurations(configurationResponse.configurations);
      setCredentials(localCredentials);
      onConfigurationsChanged(configurationResponse.configurations);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? t.models.loadFailed(error.message)
          : t.models.loadFailedGeneric
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  // Region order follows the reader's ecosystem: a Chinese reader looks for the
  // domestic providers first, an English reader for the global ones.
  const REGION_KEYS = locale === 'en'
    ? (['GLOBAL', 'LOCAL', 'CN', 'CUSTOM'] as const)
    : (['CN', 'GLOBAL', 'LOCAL', 'CUSTOM'] as const);
  const REGIONS = REGION_KEYS.map((key) => [key, t.models.regions[key]] as const);

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
    setStatus(t.models.validating);
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
      if (!validation.ok) throw new Error(t.models.validationFailed);
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
      setStatus(t.models.connected);
      await refresh();
      setTimeout(() => setSelected(null), 500);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t.models.connectFailed);
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
    const next = window.prompt(t.models.replaceKeyPrompt);
    if (!next) return;
    await credentialStore.update(configuration.credential_id, next);
    await refresh();
  }

  const quotaDescription = describeQuotaWindows(cloud);
  const resolvedCloudService =
    cloudService ??
    resolveCloudModelServiceState(cloud, {
      offline,
      selected: usageMode === 'PLATFORM'
    });
  // Usability is the server's answer, never a local reading of the numbers.
  const platformUsable = resolvedCloudService.availability === 'available';
  const cloudNotice = resolveCloudNotice(cloud);

  function focusProviderCatalog() {
    providerSearchRef.current?.focus();
  }

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="settings-panel" role="dialog" aria-modal="true" aria-label={t.models.eyebrow} onMouseDown={(event) => event.stopPropagation()}>
        <header className="settings-header">
          <div>
            <span className="eyebrow">{t.models.eyebrow}</span>
            <h2>{selected ? selected.name : t.models.title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={t.common.close}><X size={19} /></button>
        </header>

        {selected ? (
          <form className="provider-form" onSubmit={save}>
            <button type="button" className="back-link" onClick={() => setSelected(null)}><ChevronLeft size={16} /> {t.models.backToProviders}</button>
            <label>{t.models.configurationName}<input value={label} onChange={(event) => setLabel(event.target.value)} required /></label>
            <label>{t.models.baseUrl}<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={!selected.allowCustomBaseUrl} required={selected.id === 'custom-openai'} placeholder="https://example.com/v1" /></label>
            <label>{t.models.modelId}<input value={model} onChange={(event) => setModel(event.target.value)} required placeholder={t.models.modelIdPlaceholder} /></label>
            <label>{t.models.apiKey}<input type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required={selected.apiKeyRequired} placeholder={selected.apiKeyRequired ? t.models.apiKeyPlaceholder : t.models.apiKeyOptional} /></label>
            <p className="privacy-note"><KeyRound size={16} /> {t.models.privacyNote}</p>
            {selected.notice && <p className="provider-notice">{selected.notice}</p>}
            {selected.helpUrl && <a className="docs-link" href={selected.helpUrl} target="_blank" rel="noreferrer">{t.models.providerDocs} <ExternalLink size={14} /></a>}
            {status && <p className="form-status" role="status">{status}</p>}
            <button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} {t.models.validateAndSave}</button>
          </form>
        ) : (
          <div className="provider-content">
            <section className="model-service-overview" aria-label={t.models.statusLabel}>
              {/* The allowance is named, metered and sourced. It used to be one
                  bare number, which read as invented — and it never said which
                  service was paying for it. */}
              <article
                className={`service-card ${initialSection === 'platform' ? 'is-focused' : ''}`}
              >
                <div className="service-card-head">
                  <span className="service-mark">LT</span>
                  <div>
                    <h3>{cloudName}</h3>
                    <small>{t.models.cloudBlurb}</small>
                  </div>
                  {usageMode === 'PLATFORM' && platformUsable && (
                    <span className="service-badge">{t.models.inUse}</span>
                  )}
                </div>

                {resolvedCloudService.availability === 'checking' ? (
                  <p className="service-unavailable service-checking" role="status">
                    <LoaderCircle className="spin" size={15} />
                    {t.models.checkingCloud}
                  </p>
                ) : platformUsable && quotaDescription ? (
                  <div className="quota-readout">
                    <div className="quota-figure">
                      <strong>{quotaDescription.dailyRemaining}</strong>
                      <span>
                        {t.models.quotaRemaining(
                          quotaDescription.dailyLimit,
                          quotaDescription.unitName
                        )}
                      </span>
                    </div>
                    <div
                      className="quota-meter"
                      role="meter"
                      aria-valuemin={0}
                      aria-valuemax={quotaDescription.dailyLimit}
                      aria-valuenow={quotaDescription.dailyRemaining}
                      aria-label={t.models.quotaMeterLabel(t.models.dailyWindow)}
                    >
                      <i style={{ width: `${percent(quotaDescription.dailyRatio)}%` }} />
                    </div>
                    <div
                      className="quota-meter"
                      role="meter"
                      aria-valuemin={0}
                      aria-valuemax={quotaDescription.periodLimit}
                      aria-valuenow={quotaDescription.periodRemaining}
                      aria-label={t.models.quotaMeterLabel(t.models.periodWindow)}
                    >
                      <i style={{ width: `${percent(quotaDescription.periodRatio)}%` }} />
                    </div>
                    <dl className="quota-facts">
                      <div>
                        <dt>{t.models.dailyWindow}</dt>
                        <dd>{t.models.dailyResets(quotaDescription.dayUtc)}</dd>
                      </div>
                      <div>
                        <dt>{t.models.quotaUsed}</dt>
                        <dd>
                          {quotaDescription.dailyUsed} {quotaDescription.unitName}
                        </dd>
                      </div>
                      <div>
                        <dt>{t.models.periodWindow}</dt>
                        <dd>
                          {t.models.periodResets(
                            new Date(quotaDescription.periodEndsAt).toLocaleString(locale)
                          )}
                        </dd>
                      </div>
                    </dl>
                    {offline && (
                      <p className="quota-stale" role="status">
                        {t.models.quotaStale(cloudName)}
                      </p>
                    )}
                  </div>
                ) : resolvedCloudService.availability === 'blocked' && cloudNotice ? (
                  <>
                    <strong className="service-status-label">{cloudNotice.title}</strong>
                    <p className="service-unavailable">{cloudNotice.body}</p>
                    {cloudNotice.byokHint && (
                      <p className="service-byok-hint">{cloudNotice.byokHint}</p>
                    )}
                    <div className="service-card-actions">
                      {resolvedCloudService.blockReason === 'PROVIDER_UNAVAILABLE' && (
                        <button type="button" onClick={onRetryCloud}>
                          {t.models.retryCloud}
                        </button>
                      )}
                      <button type="button" onClick={focusProviderCatalog}>
                        {t.models.connectOwnModelAction}
                      </button>
                    </div>
                  </>
                ) : resolvedCloudService.availability === 'offline' ? (
                  <>
                    <strong className="service-status-label">
                      {t.models.temporarilyUnavailable}
                    </strong>
                    <p className="service-unavailable">
                      {t.models.platformUnavailable(cloudName)}
                    </p>
                    {quotaDescription && (
                      <>
                        <p className="service-quota-paused">
                          {t.models.quotaAfterRecovery(quotaDescription.dailyRemaining)}
                        </p>
                        {offline && (
                          <p className="quota-stale" role="status">
                            {t.models.quotaStale(cloudName)}
                          </p>
                        )}
                      </>
                    )}
                    <div className="service-card-actions">
                      <button type="button" onClick={onRetryCloud}>
                        {t.models.retryCloud}
                      </button>
                      <button type="button" onClick={focusProviderCatalog}>
                        {t.models.connectOwnModelAction}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="service-unavailable">
                    {t.models.noQuotaOnAccount(cloudName)}
                  </p>
                )}

                {platformUsable && (
                  <button
                    type="button"
                    aria-pressed={usageMode === 'PLATFORM'}
                    onClick={() => onUsageMode?.('PLATFORM')}
                  >
                    {usageMode === 'PLATFORM'
                      ? t.models.usingThis
                      : t.models.useCloud(cloudName)}
                  </button>
                )}
              </article>

              <article
                className={`service-card ${initialSection === 'byok' ? 'is-focused' : ''}`}
              >
                <div className="service-card-head">
                  <span className="service-mark service-mark-byok"><KeyRound size={17} /></span>
                  <div>
                    <h3>{t.models.ownModel}</h3>
                    <small>{t.models.ownModelBlurb}</small>
                  </div>
                  {usageMode === 'BYOK' && configurations.length > 0 && (
                    <span className="service-badge">{t.models.inUse}</span>
                  )}
                </div>

                {configurations.length > 0 ? (
                  <dl className="quota-facts">
                    <div>
                      <dt>{t.models.connectedLabel}</dt>
                      <dd>{t.models.connectedCount(configurations.length)}</dd>
                    </div>
                    <div>
                      <dt>{t.models.currentLabel}</dt>
                      <dd>{configurations[0]!.display_name}</dd>
                    </div>
                    <div>
                      <dt>{t.models.keyLocation}</dt>
                      <dd>{t.models.keyLocationValue}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="service-unavailable">
                    {t.models.ownModelEmpty}
                  </p>
                )}

                {configurations.length > 0 && (
                  <button
                    type="button"
                    aria-pressed={usageMode === 'BYOK'}
                    onClick={() => onUsageMode?.('BYOK')}
                  >
                    {usageMode === 'BYOK' ? t.models.usingThis : t.models.useOwnModel}
                  </button>
                )}
              </article>
            </section>
            {loading ? (
              <div className="provider-empty-state" role="status">
                <LoaderCircle className="spin" size={24} />
                <strong>{t.models.loadingProviders}</strong>
              </div>
            ) : loadError ? (
              <div className="provider-empty-state provider-load-error" role="alert">
                <strong>{loadError}</strong>
                <span>{t.models.keysUnaffected}</span>
                <button className="secondary-button" type="button" onClick={() => void refresh()}>
                  {t.common.retry}
                </button>
              </div>
            ) : (
              <>
            {configurations.length > 0 && <section><h3>{t.models.connectedLabel}</h3><div className="connected-list">{configurations.map((configuration) => {
              const local = credentials.find((item) => item.credentialId === configuration.credential_id);
              return <article className="connected-card" key={configuration.model_configuration_id}><div><strong>{configuration.display_name}</strong><span>{configuration.model_name}</span><small>{local?.maskedKey ?? t.models.keyMissing}</small></div><div className="row-actions"><button onClick={() => void replaceKey(configuration)}>{t.models.replaceKey}</button><button className="danger-icon" aria-label={t.models.deleteConfiguration} onClick={() => void remove(configuration)}><Trash2 size={16} /></button></div></article>;
            })}</div></section>}

            <div className="provider-search">
              <Search size={15} />
              <input
                ref={providerSearchRef}
                type="search"
                aria-label={t.models.searchLabel}
                placeholder={t.models.searchPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {visibleRegions.length === 0 ? (
              <p className="provider-no-match" role="status">{t.models.noMatch(query)}</p>
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
                            <small>{provider.id === 'custom-openai' ? t.models.anyOpenAiCompatible : provider.baseUrl.replace(/^https?:\/\//, '')}</small>
                          </span>
                          {connected ? <span className="provider-connected">{t.models.alreadyConnected}</span> : <Plus size={17} />}
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
