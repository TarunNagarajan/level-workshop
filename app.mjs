import express from 'express';
import { readFileSync } from 'node:fs';
import { createWorkshop } from './server/workshop.mjs';
import { neonStore } from './server/postgres-store.mjs';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  next();
});

if (!process.env.DATABASE_URL || !process.env.WORKSHOP_OWNER_KEY || !process.env.WORKSHOP_SHARE_KEY) {
  app.use('/api', (req, res) => res.status(503).json({ error: 'The workshop is being configured. Please try again shortly.' }));
} else {
  const workshop = createWorkshop({
    store: neonStore(process.env.DATABASE_URL),
    ownerKey: process.env.WORKSHOP_OWNER_KEY,
    sharingKey: process.env.WORKSHOP_SHARE_KEY,
    secureCookies: true,
    publicOrigin: process.env.PUBLIC_ORIGIN || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : ''),
  });
  workshop.app.set('trust proxy', 1);
  app.use(workshop.app);
}
const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
app.get('/{*path}', (req, res) => res.type('html').send(html));
export default app;
