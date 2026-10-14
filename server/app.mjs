import { openStore } from './store.mjs';
import { createWorkshop as createCore } from './workshop.mjs';
export function createWorkshop({ dbPath = 'data/workshop.sqlite', ...options } = {}) {
  return createCore({ ...options, store: options.store || openStore(dbPath), secureCookies: process.env.COOKIE_SECURE === 'true', publicOrigin: process.env.PUBLIC_ORIGIN || '' });
}
