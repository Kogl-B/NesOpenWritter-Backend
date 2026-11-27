import { buildApp } from './app.js';
import { startAiJobs } from './lib/ai/jobs.js';
import { env } from './lib/env.js';
import { startTelegramPolling } from './lib/publish/telegramBotClient.js';

// Catch any unhandled rejection / exception before pino is up,
// so Railway captures the cause instead of a silent exit(1).
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

async function main(): Promise<void> {
  console.log(`[boot] starting on ${env.HOST}:${env.PORT} (NODE_ENV=${env.NODE_ENV})`);
  const app = await buildApp();
  console.log('[boot] app built, listening...');

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    console.log(`[boot] listening on ${env.HOST}:${env.PORT}`);
  } catch (err) {
    console.error('[boot] listen failed:', err);
    process.exit(1);
  }

  try {
    await startAiJobs();
  } catch (err) {
    console.error('[boot] очередь генераций не стартовала:', err);
  }

  const telegram = startTelegramPolling();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutdown initiated');
    telegram.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
