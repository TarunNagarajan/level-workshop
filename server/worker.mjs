import { env } from 'cloudflare:workers';
import { createServer } from 'node:http';
import { httpServerHandler } from 'cloudflare:node';
import { createWorkshop } from './workshop.mjs';
import { d1Store } from './d1-store.mjs';
import { modelConfig } from './model.mjs';

if (!env.WORKSHOP_OWNER_KEY) throw new Error('The private owner credential is not configured.');
const { app } = createWorkshop({ store: d1Store(env.DB), provider: modelConfig(env), ownerKey: env.WORKSHOP_OWNER_KEY, sharingKey: env.WORKSHOP_SHARE_KEY, secureCookies: true, publicOrigin: env.PUBLIC_ORIGIN || '' });
const nodeHandler = httpServerHandler(createServer(app));

export default {
  async fetch(request, bindings, context) {
    try {
      const pathname = new URL(request.url).pathname;
      const assetRequest = !pathname.includes('.') ? new Request(new URL('/', request.url), request) : request;
      const response = pathname.startsWith('/api/')
        ? await nodeHandler.fetch(request, bindings, context)
        : await bindings.ASSETS.fetch(assetRequest);
      const safe = new Response(response.body, response);
      safe.headers.set('Referrer-Policy', 'no-referrer');
      safe.headers.set('X-Content-Type-Options', 'nosniff');
      safe.headers.set('X-Frame-Options', 'DENY');
      return safe;
    } catch (error) {
      console.error('Workshop unavailable:', error.message);
      return Response.json({ error: 'The workshop is temporarily unavailable. Please retry.' }, { status: 503 });
    }
  },
};
