import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';

test('opening an existing SQLite workshop preserves runs while adding event ordering', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workshop-migration-'));
  const path = join(directory, 'workshop.db');
  let store;
  try {
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE orchestration_runs (id TEXT PRIMARY KEY, config_id TEXT NOT NULL, author_id TEXT NOT NULL, snapshot TEXT NOT NULL, test_input TEXT NOT NULL, model TEXT NOT NULL, messages TEXT NOT NULL, board TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    old.exec('CREATE TABLE orchestration_world_pairs (id TEXT PRIMARY KEY, config_id TEXT NOT NULL, author_id TEXT NOT NULL, source_lane TEXT NOT NULL, target_lane TEXT NOT NULL, source_system_template TEXT NOT NULL, provider_base_url TEXT NOT NULL, created_at INTEGER NOT NULL)');
    old.prepare('INSERT INTO orchestration_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('old-run', 'config', 'author', '{}', 'case', 'old-model', '[]', '[]', 1, 1);
    old.prepare('INSERT INTO orchestration_world_pairs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('old-pair', 'config', 'author', 'A', 'B', 'Color {{FACT}}', 'https://example.test', 1);
    old.close();
    store = openStore(path);
    const run = store.get('SELECT id, event_seq FROM orchestration_runs WHERE id = ?', 'old-run');
    assert.deepEqual({ ...run }, { id: 'old-run', event_seq: 0 });
    assert.equal(store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_events'")?.name, 'orchestration_events');
    assert.equal(store.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_world_bindings'")?.name, 'orchestration_world_bindings');
    assert.equal(store.get('SELECT observation_mode FROM orchestration_world_pairs WHERE id = ?', 'old-pair')?.observation_mode, 'prompt');
  } finally {
    store?.db.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
