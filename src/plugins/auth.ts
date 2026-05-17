import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { auth } from '../lib/auth.js';

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

  // Vercel rewrite (rewrites from `nes-open-writter.vercel.app/api/*` to
  // Railway) strips the Origin header. Better-Auth requires Origin for CSRF
  // protection on state-changing endpoints (sign-out, change-password, etc).
  // Reconstruct Origin from X-Forwarded-* headers that Vercel adds. These
  // headers are set by the trusted proxy, not by user input, so it's safe.
  if (!headers.has('origin')) {
    const fwdHost = headers.get('x-forwarded-host');
    const fwdProto = headers.get('x-forwarded-proto') ?? 'https';
    if (fwdHost) {
      headers.set('origin', `${fwdProto}://${fwdHost}`);
    }
  }

  return headers;
}

const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req) => {
    const headers = toWebHeaders(req.headers);
    const result = await auth.api.getSession({ headers });
    if (result) {
      req.user = result.user;
      req.session = result.session;
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
      const url = new URL(req.url, `${req.protocol}://${req.hostname}`);
      const request = new Request(url, {
        method: req.method,
        headers: toWebHeaders(req.headers),
        body:
          req.method === 'GET' || req.method === 'HEAD'
            ? undefined
            : JSON.stringify(req.body ?? {}),
      });

      const response = await auth.handler(request);

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });
      const text = await response.text();
      return reply.send(text);
    },
  });
};

export default fp(authPlugin, { name: 'auth' });
