/**
 * LiteTavern Cloud configuration.
 *
 * Everything a hosted deployment can tune lives here, read from the environment at
 * boot. Nothing in this file may be shipped to the browser: the client learns quota
 * sizes, stage names and support copy only through `GET /v1/cloud/status` and
 * `GET /v1/cloud/support`, never by hardcoding them.
 */

export type CloudStage = 'ALPHA' | 'BETA';

export interface AlphaQuotaPolicy {
  /** Allowance granted at the start of each cycle, in quota units (1 unit = 1 reply). */
  cycleUnits: number;
  /** Length of a cycle in days. Cycle boundaries are stored as explicit instants. */
  cycleDays: number;
  /** Alpha does not carry unused allowance forward by default. */
  carryOver: boolean;
  /** Hard ceiling on how much one request may consume. */
  maxUnitsPerRequest: number;
  /** 0 disables the per-day cap. */
  dailyUnitLimit: number;
  /** Per-user requests per minute while on Alpha quota. */
  userRateLimitPerMinute: number;
  /** provider:model -> multiplier applied to the units a request costs. */
  modelMultipliers: Record<string, number>;
}

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
  /** USD per 1M cached input tokens, when the provider reports them. */
  cachedInputPerMillion: number;
}

export interface CloudSupportConfig {
  enabled: boolean;
  url: string;
  headline: string;
  body: string;
  /** Whether a public thanks list is shown at all (supporters still opt in per row). */
  thanksListEnabled: boolean;
}

export interface CloudConfig {
  stage: CloudStage;
  trialEnabled: boolean;
  trialUnits: number;
  defaultAlphaPolicy: AlphaQuotaPolicy;
  /** 0 disables the global spend circuit breaker. */
  globalMonthlyBudgetUsd: number;
  modelPrices: Record<string, ModelPrice>;
  support: CloudSupportConfig;
  /** Empty disables every admin route; there is no default credential. */
  adminToken: string;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
}

function readInteger(
  value: string | undefined,
  fallback: number,
  minimum = 0
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

/** Multipliers/prices are operator-supplied JSON, so every entry is validated. */
function sanitizeMultipliers(raw: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const multiplier = Number(value);
    if (Number.isFinite(multiplier) && multiplier > 0) result[key] = multiplier;
  }
  return result;
}

function sanitizePrices(raw: Record<string, unknown>): Record<string, ModelPrice> {
  const result: Record<string, ModelPrice> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const price: ModelPrice = {
      inputPerMillion: readNumber(String(entry.input ?? entry.inputPerMillion), 0),
      outputPerMillion: readNumber(String(entry.output ?? entry.outputPerMillion), 0),
      cachedInputPerMillion: readNumber(
        String(entry.cached ?? entry.cachedInputPerMillion),
        0
      )
    };
    result[key] = price;
  }
  return result;
}

export function loadCloudConfig(
  environment: NodeJS.ProcessEnv = process.env
): CloudConfig {
  const stage: CloudStage =
    environment.CLOUD_STAGE?.toUpperCase() === 'BETA' ? 'BETA' : 'ALPHA';

  return {
    stage,
    // Trial reuses the existing official-free-reply switch and size, so a deployment
    // that already configured them keeps working unchanged.
    trialEnabled: readBoolean(environment.FREE_QUOTA_ENABLED, true),
    trialUnits: readInteger(environment.FREE_QUOTA_INITIAL_COUNT, 30),
    defaultAlphaPolicy: {
      cycleUnits: readInteger(environment.CLOUD_ALPHA_CYCLE_UNITS, 300, 1),
      cycleDays: readInteger(environment.CLOUD_ALPHA_CYCLE_DAYS, 30, 1),
      carryOver: readBoolean(environment.CLOUD_ALPHA_CARRY_OVER, false),
      maxUnitsPerRequest: readInteger(
        environment.CLOUD_ALPHA_MAX_UNITS_PER_REQUEST,
        4,
        1
      ),
      dailyUnitLimit: readInteger(environment.CLOUD_ALPHA_DAILY_UNIT_LIMIT, 60),
      userRateLimitPerMinute: readInteger(
        environment.CLOUD_ALPHA_USER_RATE_LIMIT_PER_MINUTE,
        20,
        1
      ),
      modelMultipliers: sanitizeMultipliers(
        readJson<Record<string, unknown>>(
          environment.CLOUD_ALPHA_MODEL_MULTIPLIERS,
          {}
        )
      )
    },
    globalMonthlyBudgetUsd: readNumber(
      environment.CLOUD_GLOBAL_MONTHLY_BUDGET_USD,
      0
    ),
    modelPrices: sanitizePrices(
      readJson<Record<string, unknown>>(environment.CLOUD_MODEL_PRICES, {})
    ),
    support: {
      enabled: readBoolean(environment.CLOUD_SUPPORT_ENABLED, false),
      url: environment.CLOUD_SUPPORT_URL ?? '',
      headline: environment.CLOUD_SUPPORT_HEADLINE ?? '支持 LiteTavern',
      body:
        environment.CLOUD_SUPPORT_BODY ??
        '你的贡献将用于 LiteTavern Cloud 的模型额度、服务器和持续开发。',
      thanksListEnabled: readBoolean(environment.CLOUD_SUPPORT_THANKS_LIST, false)
    },
    adminToken: environment.CLOUD_ADMIN_TOKEN ?? ''
  };
}

/** The quota policy stored on a batch, merged over the deployment default. */
export function resolveAlphaPolicy(
  fallback: AlphaQuotaPolicy,
  stored: unknown
): AlphaQuotaPolicy {
  if (!stored || typeof stored !== 'object') return fallback;
  const raw = stored as Record<string, unknown>;
  const integer = (value: unknown, base: number, minimum: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= minimum ? parsed : base;
  };
  return {
    cycleUnits: integer(raw.cycle_units, fallback.cycleUnits, 1),
    cycleDays: integer(raw.cycle_days, fallback.cycleDays, 1),
    carryOver:
      typeof raw.carry_over === 'boolean' ? raw.carry_over : fallback.carryOver,
    maxUnitsPerRequest: integer(
      raw.max_units_per_request,
      fallback.maxUnitsPerRequest,
      1
    ),
    dailyUnitLimit: integer(raw.daily_unit_limit, fallback.dailyUnitLimit, 0),
    userRateLimitPerMinute: integer(
      raw.user_rate_limit_per_minute,
      fallback.userRateLimitPerMinute,
      1
    ),
    modelMultipliers:
      raw.model_multipliers && typeof raw.model_multipliers === 'object'
        ? sanitizeMultipliers(raw.model_multipliers as Record<string, unknown>)
        : fallback.modelMultipliers
  };
}

/** Serialize a policy back into the JSONB column shape (snake_case). */
export function serializeAlphaPolicy(policy: AlphaQuotaPolicy) {
  return {
    cycle_units: policy.cycleUnits,
    cycle_days: policy.cycleDays,
    carry_over: policy.carryOver,
    max_units_per_request: policy.maxUnitsPerRequest,
    daily_unit_limit: policy.dailyUnitLimit,
    user_rate_limit_per_minute: policy.userRateLimitPerMinute,
    model_multipliers: policy.modelMultipliers
  };
}
