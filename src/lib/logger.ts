import { pino } from 'pino';
import type { FastifyServerOptions } from 'fastify';

import { env } from './env.js';

const isDev = env.NODE_ENV === 'development';

export const loggerConfig: FastifyServerOptions['logger'] = {
  level: env.LOG_LEVEL,
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  }),
};

/**
 * Standalone pino logger for modules that need to log outside of a Fastify
 * request context (e.g. email senders, scheduled jobs). Uses the same
 * config as Fastify's instance.
 */
export const logger = pino(
  typeof loggerConfig === 'object' && loggerConfig !== null ? loggerConfig : {},
);
