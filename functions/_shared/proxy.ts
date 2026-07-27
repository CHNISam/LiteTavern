interface GatewayBinding {
  fetch(request: Request): Promise<Response>;
}

interface PagesEnv {
  POMCHAT_GATEWAY?: GatewayBinding;
  POMCHAT_GATEWAY_ORIGIN?: string;
}

export interface PagesContext {
  request: Request;
  env: PagesEnv;
}

export async function proxyToGateway(context: PagesContext) {
  if (context.env.POMCHAT_GATEWAY) {
    return context.env.POMCHAT_GATEWAY.fetch(context.request);
  }

  const origin = context.env.POMCHAT_GATEWAY_ORIGIN;
  if (!origin) {
    return Response.json(
      {
        error: {
          code: 'GATEWAY_NOT_CONFIGURED',
          message: '服务网关暂未配置。',
          retryable: false
        }
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const gateway = new URL(origin);
  if (gateway.protocol !== 'https:') {
    return Response.json(
      {
        error: {
          code: 'GATEWAY_NOT_CONFIGURED',
          message: '服务网关配置无效。',
          retryable: false
        }
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const incoming = new URL(context.request.url);
  gateway.pathname = incoming.pathname;
  gateway.search = incoming.search;
  return fetch(new Request(gateway, context.request));
}
