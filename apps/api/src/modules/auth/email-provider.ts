// Email delivery is abstracted behind a small provider interface so business code
// never talks to a specific vendor. Development and tests use in-process adapters;
// production is wired from environment variables (see loadEmailProvider). The
// verification code is a transient secret — it must never be logged, so the console
// adapter only prints it when explicitly running outside production.

export interface VerificationEmail {
  to: string;
  code: string;
  /** Minutes until the code expires, for the message body. */
  expiresInMinutes: number;
}

export interface EmailProvider {
  readonly name: string;
  sendVerificationCode(email: VerificationEmail): Promise<void>;
}

export function renderVerificationEmail(email: VerificationEmail): {
  subject: string;
  text: string;
} {
  return {
    subject: 'LiteTavern 登录验证码',
    text:
      `你的 LiteTavern 验证码是：${email.code}\n\n` +
      `验证码将在 ${email.expiresInMinutes} 分钟后失效。` +
      `如果这不是你的操作，可以忽略此邮件。`
  };
}

/** Records every sent code in memory. Used by tests to read the delivered code. */
export class MemoryEmailProvider implements EmailProvider {
  readonly name = 'memory';
  readonly sent: VerificationEmail[] = [];

  async sendVerificationCode(email: VerificationEmail): Promise<void> {
    this.sent.push(email);
  }

  lastCodeFor(email: string): string | undefined {
    const normalized = email.trim().toLowerCase();
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      if (this.sent[index]!.to === normalized) return this.sent[index]!.code;
    }
    return undefined;
  }
}

/**
 * Development adapter: prints the rendered message (including the code) to the
 * server console so a developer can complete the flow without a real mailbox.
 * Refuses to expose the code in production.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  constructor(private readonly isProduction: boolean) {}

  async sendVerificationCode(email: VerificationEmail): Promise<void> {
    if (this.isProduction) {
      throw new Error(
        'ConsoleEmailProvider must not be used in production; configure a real EMAIL_PROVIDER.'
      );
    }
    const rendered = renderVerificationEmail(email);
    console.info(
      `\n[dev-email] → ${email.to}\n[dev-email] ${rendered.subject}\n[dev-email] ${rendered.text}\n`
    );
  }
}

/**
 * Production HTTP adapter placeholder. It intentionally does not hardcode a vendor:
 * it posts the rendered message to EMAIL_HTTP_ENDPOINT with a bearer token. Swap or
 * extend for the chosen provider. Throws clearly when unconfigured so a missing
 * setup fails loud rather than silently dropping login emails.
 */
export class HttpEmailProvider implements EmailProvider {
  readonly name = 'http';
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly fromAddress: string,
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async sendVerificationCode(email: VerificationEmail): Promise<void> {
    const rendered = renderVerificationEmail(email);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: email.to,
          subject: rendered.subject,
          text: rendered.text
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Email endpoint responded ${response.status}.`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface EmailProviderConfig {
  provider: EmailProvider;
  /** Environment settings that still need configuring for production delivery. */
  pendingConfig: string[];
}

export function loadEmailProvider(
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch
): EmailProviderConfig {
  const isProduction = environment.NODE_ENV === 'production';
  const kind = environment.EMAIL_PROVIDER ?? (isProduction ? 'http' : 'console');
  const pendingConfig: string[] = [];

  if (kind === 'http') {
    const endpoint = environment.EMAIL_HTTP_ENDPOINT ?? '';
    const apiKey = environment.EMAIL_HTTP_API_KEY ?? '';
    const fromAddress = environment.EMAIL_FROM_ADDRESS ?? '';
    const timeoutMs = Number(environment.EMAIL_HTTP_TIMEOUT_MS ?? 10_000) || 10_000;
    if (!endpoint) pendingConfig.push('EMAIL_HTTP_ENDPOINT');
    if (!apiKey) pendingConfig.push('EMAIL_HTTP_API_KEY');
    if (!fromAddress) pendingConfig.push('EMAIL_FROM_ADDRESS');
    if (pendingConfig.length === 0) {
      return {
        provider: new HttpEmailProvider(endpoint, apiKey, fromAddress, timeoutMs, fetcher),
        pendingConfig
      };
    }
    // Fall back to the console adapter in non-production so local runs still work.
    if (!isProduction) {
      return { provider: new ConsoleEmailProvider(false), pendingConfig };
    }
  }

  return { provider: new ConsoleEmailProvider(isProduction), pendingConfig };
}
