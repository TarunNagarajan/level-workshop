import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  password: text('password').notNull(),
  role: text('role').notNull(),
  created_at: integer('created_at').notNull(),
}, t => [
  uniqueIndex('one_workspace_owner').on(t.role).where(sql`role = 'admin'`),
  uniqueIndex('users_email_unique').on(t.email),
]);

export const auth = sqliteTable('auth', {
  token: text('token').primaryKey(),
  user_id: text('user_id').references(() => users.id),
  expires: integer('expires').notNull(),
});

export const invites = sqliteTable('invites', {
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  role: text('role').notNull(),
  expires: integer('expires').notNull(),
  used: integer('used').default(0),
}, t => [
  uniqueIndex('invites_token_unique').on(t.token),
]);

export const levels = sqliteTable('levels', {
  id: text('id').primaryKey(),
  owner_id: text('owner_id').references(() => users.id),
  draft: text('draft').notNull(),
  revision: integer('revision').default(1),
  status: text('status').default('draft'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
});

export const versions = sqliteTable('versions', {
  id: text('id').primaryKey(),
  level_id: text('level_id').references(() => levels.id),
  number: integer('number').notNull(),
  data: text('data').notNull(),
  note: text('note').notNull(),
  author_id: text('author_id').references(() => users.id),
  created_at: integer('created_at').notNull(),
}, t => [
  uniqueIndex('versions_level_id_number_unique').on(t.level_id, t.number),
]);

export const links = sqliteTable('links', {
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  version_id: text('version_id').references(() => versions.id),
  created_at: integer('created_at').notNull(),
  expires: integer('expires').notNull(),
  revoked: integer('revoked').default(0),
}, t => [
  uniqueIndex('links_token_unique').on(t.token),
]);

export const rounds = sqliteTable('rounds', {
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  level_id: text('level_id').references(() => levels.id),
  version_id: text('version_id').references(() => versions.id),
  author_id: text('author_id').references(() => users.id),
  source: text('source').notNull(),
  data: text('data').notNull(),
  config: text('config').notNull(),
  tester: text('tester').notNull(),
  messages: text('messages').notNull(),
  hints_used: integer('hints_used').default(0),
  started_at: integer('started_at').notNull(),
  ended_at: integer('ended_at'),
  answer: text('answer'),
  parent_id: text('parent_id'),
}, t => [
  index('rounds_level').on(t.level_id, t.started_at),
  uniqueIndex('rounds_token_unique').on(t.token),
]);

export const reviews = sqliteTable('reviews', {
  round_id: text('round_id').primaryKey().references(() => rounds.id),
  outcome: text('outcome').notNull(),
  note: text('note').notNull(),
  evidence: text('evidence').notNull(),
  reviewer_id: text('reviewer_id').references(() => users.id),
  updated_at: integer('updated_at').notNull(),
});

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  level_id: text('level_id').references(() => levels.id),
  user_id: text('user_id').references(() => users.id),
  text: text('text').notNull(),
  created_at: integer('created_at').notNull(),
});

export const workshop_links = sqliteTable('workshop_links', {
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  created_at: integer('created_at').notNull(),
  expires: integer('expires').notNull(),
  revoked: integer('revoked').notNull().default(0),
}, t => [
  uniqueIndex('workshop_links_token_unique').on(t.token),
]);

export const link_sessions = sqliteTable('link_sessions', {
  auth_token: text('auth_token').primaryKey().references(() => auth.token, { onDelete: 'cascade' }),
  link_id: text('link_id').notNull().references(() => workshop_links.id),
});

export const invite_claims = sqliteTable('invite_claims', {
  invite_id: text('invite_id').primaryKey().references(() => invites.id),
  user_id: text('user_id').notNull(),
});

export const round_locks = sqliteTable('round_locks', {
  round_id: text('round_id').primaryKey().references(() => rounds.id),
  token: text('token').notNull(),
  expires: integer('expires').notNull(),
});

export const onboarding = sqliteTable('onboarding', {
  user_id: text('user_id').primaryKey().references(() => users.id),
  version: integer('version').notNull(),
  result: text('result').notNull(),
  completed_at: integer('completed_at').notNull(),
});

export const passport_sessions = sqliteTable('passport_sessions', {
  round_id: text('round_id').primaryKey().references(() => rounds.id),
  state: text('state').notNull(),
});

export const orchestration_configs = sqliteTable('orchestration_configs', {
  id: text('id').primaryKey(),
  owner_id: text('owner_id').notNull().references(() => users.id),
  draft: text('draft').notNull(),
  revision: integer('revision').notNull().default(1),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
});

export const orchestration_versions = sqliteTable('orchestration_versions', {
  id: text('id').primaryKey(),
  config_id: text('config_id').notNull().references(() => orchestration_configs.id),
  number: integer('number').notNull(),
  data: text('data').notNull(),
  note: text('note').notNull(),
  author_id: text('author_id').notNull().references(() => users.id),
  created_at: integer('created_at').notNull(),
}, t => [uniqueIndex('orchestration_versions_config_id_number_unique').on(t.config_id, t.number)]);

export const orchestration_runs = sqliteTable('orchestration_runs', {
  id: text('id').primaryKey(),
  config_id: text('config_id').notNull().references(() => orchestration_configs.id),
  author_id: text('author_id').notNull().references(() => users.id),
  snapshot: text('snapshot').notNull(),
  test_input: text('test_input').notNull(),
  model: text('model').notNull(),
  messages: text('messages').notNull(),
  board: text('board').notNull(),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, t => [index('orchestration_runs_config').on(t.config_id, t.created_at)]);

export const orchestration_locks = sqliteTable('orchestration_locks', {
  run_id: text('run_id').primaryKey().references(() => orchestration_runs.id),
  token: text('token').notNull(),
  expires: integer('expires').notNull(),
});
