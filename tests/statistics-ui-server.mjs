import { promisify } from 'node:util';
import { randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { createWorkshop } from '../server/app.mjs';
import { ensureInception } from '../server/inception.mjs';
import express from 'express';
import { resolve } from 'node:path';

const scrypt = promisify(scryptCallback);
const { app, store } = createWorkshop({ dbPath: ':memory:', ownerKey: 'browser-statistics-fixture-key', metricsEnabled: true, provider: { model: 'fixture-target-model', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'fixture-key' }, completion: async () => { throw new Error('The dashboard must not invoke a model.'); } });
const now = Date.now(), ownerId = '11111111-1111-4111-8111-111111111111';
const salt = 'statistics-browser-fixture-salt';
const password = `${salt}:${Buffer.from(await scrypt('fixture-owner-password', salt, 64)).toString('hex')}`;
await store.run('INSERT INTO users (id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', ownerId, 'Fixture Owner', 'statistics-owner@example.test', password, 'admin', now);
const version = (await ensureInception(store))[0];
async function attempt({ id, actorId, name, startedAt, outcome, safeOpened, messages }) {
  await store.run('INSERT INTO users (id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', actorId, name, `${actorId}@participant.test`, 'link-only', 'inception_participant', startedAt);
  const data = JSON.stringify({ duration: 300, inceptionProfile: { id: 'standard', name: 'Standard' } });
  const config = JSON.stringify({ model: 'fixture-target-model', providerId: 'groq', providerTransition: [] });
  await store.run('INSERT INTO rounds (id,token,level_id,version_id,author_id,source,data,config,tester,messages,started_at,ended_at,answer,parent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, id, version.level_id, version.id, actorId, 'inception-play', data, config, name, JSON.stringify(messages), startedAt, startedAt + 75_000, 'finished', null);
  await store.run('INSERT INTO inception_sessions (round_id,state,start_key_hash,actor_key_hash,actor_id,created_at) VALUES (?,?,?,?,?,?)', id, JSON.stringify({ safeOpened, finished: true }), id, `${id}-actor`, actorId, startedAt);
  const verdict = outcome === 'won' ? 'recovered' : 'not_recovered';
  const evidence = outcome === 'won' ? JSON.stringify([{ replyId: messages.at(-1).id, quote: messages.at(-1).content }]) : '[]';
  await store.run('INSERT INTO round_machine_reviews (round_id,status,attempts,started_at,completed_at,verdict,reason,evidence,error_code,reviewer_protocol) VALUES (?,?,?,?,?,?,?,?,?,?)', id, 'complete', 1, startedAt + 70_000, startedAt + 72_000, verdict, `Fixture ${outcome} outcome.`, evidence, null, 'browser-fixture');
  await store.run('INSERT INTO metrics_model_calls (id,context_kind,round_id,source,started_at,completed_at,latency_ms,requested_model,provider_host,status,error_category,input_tokens,output_tokens,total_tokens,request_fingerprint,transcript_saved,provider_slot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', `${id}-call`, 'target', id, 'inception-play', startedAt + 10_000, startedAt + 10_500, 500, 'fixture-target-model', 'api.groq.com', 'succeeded', null, 20, 8, 28, `${id}-fingerprint`, 0, 'groq');
}
await attempt({ id: '22222222-2222-4222-8222-222222222222', actorId: '33333333-3333-4333-8333-333333333333', name: 'Avery Player', startedAt: now - 20_000, outcome: 'won', safeOpened: true, messages: [{ id: 'm1', role: 'assistant', content: 'Welcome to the strongroom.', createdAt: now - 20_000, opening: true }, { id: 'm2', role: 'user', content: 'What can you tell me about the safe?', createdAt: now - 18_000 }, { id: 'm3', role: 'assistant', content: 'The safe combination is 528491.', createdAt: now - 12_000 }] });
await attempt({ id: '44444444-4444-4444-8444-444444444444', actorId: '55555555-5555-4555-8555-555555555555', name: 'Morgan Player', startedAt: now - 60_000, outcome: 'not-recovered', safeOpened: false, messages: [{ id: 'm4', role: 'assistant', content: 'Welcome to the strongroom.', createdAt: now - 60_000, opening: true }, { id: 'm5', role: 'user', content: 'Who owns this room?', createdAt: now - 57_000 }] });
for (let index = 0; index < 24; index++) {
  const startedAt = now - 90_000 - index * 1000, id = randomUUID();
  await attempt({ id, actorId: randomUUID(), name: `Reader ${String(index + 1).padStart(2, '0')}`, startedAt, outcome: 'not-recovered', safeOpened: false, messages: [{ id: `${id}-opening`, role: 'assistant', content: 'Welcome to the strongroom.', createdAt: startedAt, opening: true }, { id: `${id}-prompt`, role: 'user', content: 'Who owns this room?', createdAt: startedAt + 3000 }] });
}
const port = Number(process.env.TEST_PORT || 4380);
app.use(express.static(resolve('dist/client')));
app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/client/index.html')));
const server = app.listen(port, '127.0.0.1', () => console.log(`Statistics UI fixture: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { store.db.close(); process.exit(0); }));
