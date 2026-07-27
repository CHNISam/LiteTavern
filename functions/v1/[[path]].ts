import { proxyToGateway, type PagesContext } from '../_shared/proxy.js';

export function onRequest(context: PagesContext) {
  return proxyToGateway(context);
}
