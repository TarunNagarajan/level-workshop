import express from 'express';
import { readFileSync } from 'node:fs';
import { createWorkshop } from './workshop.mjs';
import { neonStore } from './postgres-store.mjs';

export function createDeploymentApp({ includeSpaFallback = false, apiNotFound = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    next();
  });

  const rootEntry = process.env.WORKSHOP_ROOT_ENTRY === 'true';
  if (!process.env.DATABASE_URL || !process.env.WORKSHOP_OWNER_KEY || (!process.env.WORKSHOP_SHARE_KEY && !rootEntry)) {
    app.use('/api', (_req, res) => res.status(503).json({ error: 'The workshop is being configured. Please try again shortly.' }));
  } else {
    const workshop = createWorkshop({
      store: neonStore(process.env.DATABASE_URL),
      ownerKey: process.env.WORKSHOP_OWNER_KEY,
      sharingKey: process.env.WORKSHOP_SHARE_KEY,
      rootEntry,
      secureCookies: true,
      publicOrigin: process.env.PUBLIC_ORIGIN || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : ''),
      metricsEnabled: process.env.WORKSHOP_METRICS !== 'false',
      metricsSessionCreationLimit: 120,
    });
    workshop.app.set('trust proxy', 1);
    app.use(workshop.app);
  }

  if (apiNotFound) app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  if (includeSpaFallback) {
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    app.get('/{*path}', (_req, res) => res.type('html').send(html));
  }
  return app;
}
