import 'dotenv/config';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { existsSync } from 'node:fs';
import { createWorkshop } from './app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { app, store } = createWorkshop({ dbPath: process.env.DATABASE_PATH || resolve(root, 'data/workshop.sqlite'), passportReviewEnabled: process.env.WORKSHOP_PASSPORT_REVIEW !== 'false', recordingNoticeRequired: process.env.WORKSHOP_RECORDING_REQUIRED !== 'false' });
const client = existsSync(resolve(root, 'dist/client/index.html')) ? resolve(root, 'dist/client') : resolve(root, 'dist');
if (existsSync(resolve(client, 'index.html'))) {
  app.use(express.static(client));
  app.get('/{*path}', (req, res) => res.sendFile(resolve(client, 'index.html')));
} else {
  app.get('/', (req, res) => res.send('Build the interface with npm run build, or open the development server at http://127.0.0.1:5173.'));
}
const server = app.listen(Number(process.env.PORT || 4317), process.env.HOST || '127.0.0.1', () => console.log(`Level workshop: http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 4317}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.db.close(); process.exit(0); }));
