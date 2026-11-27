import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { auth } from '../lib/auth.js';
import { browserOrigins, env } from '../lib/env.js';
import { browserSource, writeNeedsBrowserOrigin } from '../lib/browserWritePolicy.js';

type AuthSession = typeof auth.$Infer.Session;
type AuthUser = AuthSession['user'];

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    session: AuthSession['session'] | null;
  }

  interface FastifyInstance {
    requireAuth: (req: FastifyRequest) => void;
  }
}

function toWebHeaders(nodeHeaders: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  return headers;
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);
  const trusted = new Set(browserOrigins([env.BETTER_AUTH_URL, env.FRONTEND_URL]));

  app.addHook('onRequest', async (req, reply) => {
    if (writeNeedsBrowserOrigin(req.method, req.url)) {
      const source = browserSource(req.headers);
      if (!source || !trusted.has(source)) return reply.status(403).send({ error: 'Источник запроса не разрешён.' });
    }
    if (req.routeOptions.url === '/api/auth/*') return;
    const headers = toWebHeaders(req.headers);
    // returnHeaders: продление сессии пишет Set-Cookie. Без переноса в ответ
    // браузер остаётся со старой кукой и через время выкидывает на вход.
    const result = await auth.api.getSession({ headers, returnHeaders: true });
    if (!result) return;
    const setCookies = result.headers?.getSetCookie?.() ?? [];
    // /api/auth/* сам копирует заголовки ответа, иначе кука задвоится.
    if (!req.url.startsWith('/api/auth/')) {
      for (const cookie of setCookies) reply.header('set-cookie', cookie);
    }
    if (result.response) {
      req.user = result.response.user;
      req.session = result.response.session;
    }
  });

  app.decorate('requireAuth', (req: FastifyRequest): void => {
    if (!req.user || !req.session) {
      const err = new Error('Unauthorized') as Error & { statusCode?: number };
      err.statusCode = 401;
      throw err;
    }
  });

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    url: '/api/auth/*',
    handler: async (req, reply) => {
      const url = new URL(env.BETTER_AUTH_URL);
      const queryStart = req.url.indexOf('?');
      url.pathname = queryStart === -1 ? req.url : req.url.slice(0, queryStart);
      url.search = queryStart === -1 ? '' : req.url.slice(queryStart);
      const reqHeaders = toWebHeaders(req.headers);
      const source = browserSource(req.headers);
      if (!reqHeaders.has('origin') && source && trusted.has(source)) reqHeaders.set('origin', source);

      const request = new Request(url, {
        method: req.method,
        headers: reqHeaders,
        body:
          req.method === 'GET' || req.method === 'HEAD'
            ? undefined
            : JSON.stringify(req.body ?? {}),
      });

      const response = await auth.handler(request);

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      for (const cookie of response.headers.getSetCookie()) reply.header('set-cookie', cookie);
      const text = await response.text();
      return reply.send(text);
    },
  });
};

export default fp(authPlugin, { name: 'auth' });
