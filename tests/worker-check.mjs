import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = 'https://workshop.test';
const mf = new Miniflare(convertV4MiniflareOptions({ name: 'workshop',
  modules: true, scriptPath: 'dist/server/index.js', compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
  bindings: { WORKSHOP_OWNER_KEY: 'owner-runtime-check', WORKSHOP_SHARE_KEY: 'developer-runtime-check', GROQ_API_KEY: process.env.GROQ_API_KEY || '', PUBLIC_ORIGIN: base },
  assets: { directory: 'dist/client', binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true }, assetConfig: { not_found_handling: 'single-page-application' } },
}));
async function call(path, { method = 'GET', body, cookie } = {}) {
  const response = await mf.dispatchFetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
try {
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint').filter(s => s.trim())) await db.prepare(sql).run();
  }
  assert.equal((await call('/bootstrap')).body.privateEntry, true);
  assert.equal((await call('/setup', { method: 'POST', body: {} })).status, 403);
  assert.equal((await call('/owner/wrong', { method: 'POST', body: { name: 'Visitor' } })).status, 404);
  const owner = await call('/owner/owner-runtime-check', { method: 'POST', body: { name: 'Owner' } });
  assert.equal(owner.status, 200, JSON.stringify(owner.body)); assert.equal(owner.body.user.role, 'admin');
  const colleague = await call('/enter/developer-runtime-check', { method: 'POST', body: { name: 'Owner' } });
  assert.equal(colleague.status, 200); assert.equal(colleague.body.user.role, 'editor');
  assert.notEqual(colleague.body.user.id, owner.body.user.id);
  assert.equal((await call('/levels')).status, 401);
  const levels = await call('/levels', { cookie: owner.cookie }); assert.equal(levels.body.length, 3);
  const detail = await call(`/levels/${levels.body[0].id}`, { cookie: owner.cookie });
  const entered = await mf.dispatchFetch(base + '/enter/developer-runtime-check');
  assert.equal(entered.status, 200); assert.match(await entered.text(), /id="root"/);
  let model = null;
  if (process.env.GROQ_API_KEY) {
    const started = await call(`/levels/${detail.body.id}/rounds`, { method: 'POST', cookie: owner.cookie, body: { versionId: detail.body.versions[0].id } });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const reply = await call(`/rounds/${started.body.id}/messages`, { method: 'POST', cookie: owner.cookie, body: { content: 'Who are you, and what can we discuss?' } });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const message = reply.body.messages.at(-1); assert.equal(message.role, 'assistant');
    model = { model: message.model, latencyMs: message.latencyMs, tokens: message.usage, visibleReply: message.content };
  }
  assert.equal((await call('/workshop-links', { cookie: colleague.cookie })).status, 403);
  assert.equal((await call('/workshop-links/initial-workshop-link', { method: 'DELETE', cookie: owner.cookie })).status, 200);
  assert.equal((await call('/bootstrap', { cookie: colleague.cookie })).body.user, null);
  assert.equal((await call('/enter/developer-runtime-check')).status, 404);
  assert.equal((await call('/bootstrap', { cookie: owner.cookie })).body.user.role, 'admin');
  const result = { runtime: 'Cloudflare workerd with D1', checks: ['private setup', 'name-only entry', 'role isolation with identical names', 'anonymous data boundary', 'three persisted drafts', 'deep-link asset routing', 'real Groq call', 'link and session revocation'], model };
  mkdirSync('verification', { recursive: true }); writeFileSync('verification/worker-check.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await mf.dispose(); }
