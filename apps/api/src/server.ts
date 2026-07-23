import { buildApp } from './app.js';

const app = await buildApp({ logger: true });
const port = Number(process.env.PORT ?? 3000);

try {
  const address = await app.listen({ host: '127.0.0.1', port });
  app.log.info({ address }, 'PomChat API ready');
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
