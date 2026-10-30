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
  recording_accepted_at: integer('recording_accepted_at'),
  recording_notice_version: text('recording_notice_version'),
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

export const passport_scenario_counter = sqliteTable('passport_scenario_counter', {
  id: integer('id').primaryKey(),
  value: integer('value').notNull().default(0),
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

export const user_recording_acknowledgements = sqliteTable('user_recording_acknowledgements', {
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  version: text('version').notNull(),
  accepted_at: integer('accepted_at').notNull(),
}, t => [uniqueIndex('user_recording_acknowledgements_pk').on(t.user_id, t.version)]);

export const durable_submissions = sqliteTable('durable_submissions', {
  id: text('id').primaryKey(),
  client_request_id: text('client_request_id').notNull(),
  scope_key: text('scope_key').notNull(),
  round_id: text('round_id').references(() => rounds.id, { onDelete: 'restrict' }),
  orchestration_run_id: text('orchestration_run_id').references(() => orchestration_runs.id, { onDelete: 'restrict' }),
  lane: text('lane'),
  actor_id: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
  source: text('source'),
  version_id: text('version_id'),
  collection_id: text('collection_id'),
  profile_id: text('profile_id'),
  scenario_id: text('scenario_id'),
  content: text('content').notNull(),
  desk_context: text('desk_context'),
  presented: text('presented'),
  created_at: integer('created_at').notNull(),
  started_at: integer('started_at'),
  completed_at: integer('completed_at'),
  status: text('status').notNull(),
  error_code: text('error_code'),
  reply: text('reply'),
  reply_id: text('reply_id'),
  transcript_saved: integer('transcript_saved').notNull().default(0),
}, t => [uniqueIndex('durable_submissions_scope_request_unique').on(t.scope_key, t.client_request_id), index('durable_submissions_page').on(t.created_at, t.id)]);

export const round_machine_reviews = sqliteTable('round_machine_reviews', {
  round_id: text('round_id').primaryKey().references(() => rounds.id, { onDelete: 'restrict' }),
  status: text('status').notNull(),
  attempts: integer('attempts').notNull(),
  run_id: text('run_id'),
  started_at: integer('started_at'),
  completed_at: integer('completed_at'),
  verdict: text('verdict'),
  reason: text('reason'),
  evidence: text('evidence'),
  error_code: text('error_code'),
  reviewer_protocol: text('reviewer_protocol'),
});

export const difficulty_collections = sqliteTable('difficulty_collections', {
  id: text('id').primaryKey(),
  owner_id: text('owner_id').notNull().references(() => users.id),
  source_level_id: text('source_level_id').notNull().references(() => levels.id),
  source_version_id: text('source_version_id').notNull().references(() => versions.id),
  snapshot: text('snapshot').notNull(),
  status: text('status').notNull().default('active'),
  revision: integer('revision').notNull().default(1),
  created_at: integer('created_at').notNull(),
}, t => [index('difficulty_collections_owner_created').on(t.owner_id, t.created_at)]);

export const difficulty_collection_links = sqliteTable('difficulty_collection_links', {
  id: text('id').primaryKey(),
  collection_id: text('collection_id').notNull().references(() => difficulty_collections.id),
  token_hash: text('token_hash').notNull(),
  created_at: integer('created_at').notNull(),
  expires: integer('expires').notNull(),
  revoked: integer('revoked').notNull().default(0),
}, t => [uniqueIndex('difficulty_collection_links_token_hash_unique').on(t.token_hash), index('difficulty_collection_links_collection').on(t.collection_id, t.created_at)]);

export const difficulty_collection_assignments = sqliteTable('difficulty_collection_assignments', {
  id: text('id').primaryKey(),
  collection_id: text('collection_id').notNull().references(() => difficulty_collections.id),
  round_id: text('round_id').notNull().references(() => rounds.id),
  profile_id: text('profile_id').notNull(),
  profile_snapshot: text('profile_snapshot').notNull(),
  source: text('source').notNull(),
  parent_id: text('parent_id'),
  link_id: text('link_id').references(() => difficulty_collection_links.id),
  start_key_hash: text('start_key_hash'),
  consent_at: integer('consent_at'),
  consent_version: text('consent_version'),
  assigned_at: integer('assigned_at').notNull(),
  question_count: integer('question_count').notNull().default(0),
}, t => [uniqueIndex('difficulty_assignments_round_unique').on(t.round_id), uniqueIndex('difficulty_assignments_link_key_unique').on(t.link_id, t.start_key_hash), index('difficulty_assignments_collection_profile').on(t.collection_id, t.profile_id, t.assigned_at), index('difficulty_assignments_collection_cursor').on(t.collection_id, t.assigned_at, t.id)]);

export const difficulty_collection_leases = sqliteTable('difficulty_collection_leases', {
  collection_id: text('collection_id').primaryKey().references(() => difficulty_collections.id),
  token: text('token').notNull(),
  expires: integer('expires').notNull(),
});

export const difficulty_provider_calls = sqliteTable('difficulty_provider_calls', {
  id: text('id').primaryKey(),
  collection_id: text('collection_id').notNull().references(() => difficulty_collections.id),
  round_id: text('round_id').notNull().references(() => rounds.id),
  status: text('status').notNull(),
  started_at: integer('started_at').notNull(),
  completed_at: integer('completed_at'),
  latency_ms: integer('latency_ms'),
  error_code: text('error_code'),
  request_context: text('request_context'),
}, t => [index('difficulty_provider_calls_collection').on(t.collection_id, t.started_at), index('difficulty_provider_calls_round').on(t.round_id, t.started_at)]);

export const difficulty_annotations = sqliteTable('difficulty_annotations', {
  round_id: text('round_id').primaryKey().references(() => rounds.id),
  attempted_strategies: text('attempted_strategies').notNull(),
  observed_failures: text('observed_failures').notNull(),
  note: text('note').notNull(),
  reviewer_id: text('reviewer_id').notNull().references(() => users.id),
  updated_at: integer('updated_at').notNull(),
});

export const metrics_sessions = sqliteTable('metrics_sessions', {
  id: text('id').primaryKey(),
  token_hash: text('token_hash').notNull(),
  user_id: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  created_at: integer('created_at').notNull(),
  last_seen_at: integer('last_seen_at').notNull(),
  expires_at: integer('expires_at').notNull(),
  closed_at: integer('closed_at'),
  event_window_started_at: integer('event_window_started_at').notNull(),
  event_window_count: integer('event_window_count').notNull().default(0),
  event_batch_token: text('event_batch_token'),
}, t => [uniqueIndex('metrics_sessions_token_hash_unique').on(t.token_hash), index('metrics_sessions_created').on(t.created_at, t.id), index('metrics_sessions_user_created').on(t.user_id, t.created_at)]);

export const metrics_events = sqliteTable('metrics_events', {
  event_id: text('event_id').primaryKey(),
  session_id: text('session_id').notNull().references(() => metrics_sessions.id, { onDelete: 'cascade' }),
  user_id: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  tab_id: text('tab_id').notNull(),
  page_id: text('page_id').notNull(),
  round_id: text('round_id').references(() => rounds.id, { onDelete: 'set null' }),
  collection_id: text('collection_id').references(() => difficulty_collections.id, { onDelete: 'set null' }),
  profile_id: text('profile_id'),
  source: text('source'),
  version_id: text('version_id'),
  event_kind: text('event_kind').notNull(),
  view_category: text('view_category').notNull(),
  phase: text('phase'),
  elapsed_ms: integer('elapsed_ms'),
  active_ms: integer('active_ms'),
  visible_ms: integer('visible_ms'),
  idle_ms: integer('idle_ms'),
  read_think_ms: integer('read_think_ms'),
  compose_ms: integer('compose_ms'),
  waiting_ms: integer('waiting_ms'),
  since_reply_ms: integer('since_reply_ms'),
  request_category: text('request_category'),
  request_outcome: text('request_outcome'),
  request_wall_ms: integer('request_wall_ms'),
  retry_count: integer('retry_count'),
  interaction: text('interaction'),
  created_at: integer('created_at').notNull(),
}, t => [index('metrics_events_session_created').on(t.session_id, t.created_at, t.event_id), index('metrics_events_created_view').on(t.created_at, t.view_category, t.event_kind), index('metrics_events_round_created').on(t.round_id, t.created_at)]);

export const metrics_model_calls = sqliteTable('metrics_model_calls', {
  id: text('id').primaryKey(),
  context_kind: text('context_kind').notNull(),
  round_id: text('round_id').references(() => rounds.id, { onDelete: 'set null' }),
  orchestration_run_id: text('orchestration_run_id').references(() => orchestration_runs.id, { onDelete: 'set null' }),
  lane: text('lane'),
  actor_user_id: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  actor_role: text('actor_role'),
  collection_id: text('collection_id').references(() => difficulty_collections.id, { onDelete: 'set null' }),
  profile_id: text('profile_id'),
  source: text('source'),
  version_id: text('version_id'),
  started_at: integer('started_at').notNull(),
  completed_at: integer('completed_at'),
  latency_ms: integer('latency_ms'),
  requested_model: text('requested_model').notNull(),
  returned_model: text('returned_model'),
  provider_host: text('provider_host'),
  provider_slot: text('provider_slot'),
  status: text('status').notNull(),
  error_category: text('error_category'),
  input_tokens: integer('input_tokens'),
  output_tokens: integer('output_tokens'),
  total_tokens: integer('total_tokens'),
  response_chars: integer('response_chars'),
  response_words: integer('response_words'),
  retry_of_id: text('retry_of_id'),
  request_fingerprint: text('request_fingerprint').notNull(),
  transcript_saved: integer('transcript_saved').notNull().default(0),
}, t => [index('metrics_model_calls_started').on(t.started_at, t.id), index('metrics_model_calls_status_started').on(t.status, t.started_at), index('metrics_model_calls_retry_fingerprint').on(t.request_fingerprint, t.started_at), index('metrics_model_calls_round_started').on(t.round_id, t.started_at), index('metrics_model_calls_collection_profile').on(t.collection_id, t.profile_id, t.started_at), index('metrics_model_calls_run_started').on(t.orchestration_run_id, t.started_at)]);

export const diary_sessions = sqliteTable('diary_sessions', {
  round_id: text('round_id').primaryKey().references(() => rounds.id, { onDelete: 'restrict' }),
  state: text('state').notNull(),
});

export const mission_sessions = sqliteTable('mission_sessions', {
  round_id: text('round_id').primaryKey().references(() => rounds.id, { onDelete: 'restrict' }),
  state: text('state').notNull(),
});

export const mission_start_keys = sqliteTable('mission_start_keys', {
  actor_id: text('actor_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  start_key_hash: text('start_key_hash').notNull(),
  round_id: text('round_id').notNull().unique().references(() => rounds.id, { onDelete: 'restrict' }),
  created_at: integer('created_at').notNull(),
}, t => [uniqueIndex('mission_start_keys_actor_key_unique').on(t.actor_id, t.start_key_hash)]);

export const mission_start_locks = sqliteTable('mission_start_locks', {
  actor_id: text('actor_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  expires_at: integer('expires_at').notNull(),
});

export const inception_sessions = sqliteTable('inception_sessions', {
  round_id: text('round_id').primaryKey().references(() => rounds.id, { onDelete: 'restrict' }),
  state: text('state').notNull(),
  start_key_hash: text('start_key_hash').notNull(),
  actor_key_hash: text('actor_key_hash').notNull(),
  actor_id: text('actor_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  created_at: integer('created_at').notNull(),
}, t => [uniqueIndex('inception_sessions_actor_key_hash_unique').on(t.actor_key_hash), index('inception_sessions_actor_created_idx').on(t.actor_id, t.created_at)]);

export const inception_start_locks = sqliteTable('inception_start_locks', {
  actor_id: text('actor_id').primaryKey().references(() => users.id, { onDelete: 'restrict' }),
  serial: integer('serial').notNull().default(0),
});

export const inception_provider_health = sqliteTable('inception_provider_health', {
  provider_id: text('provider_id').primaryKey(),
  observed_at: integer('observed_at').notNull(),
  last_success_at: integer('last_success_at'),
  blocked_until: integer('blocked_until'),
  last_error_code: text('last_error_code'),
  daily_limit: integer('daily_limit'),
  daily_used: integer('daily_used'),
  daily_observed_at: integer('daily_observed_at'),
  app_tokens_today: integer('app_tokens_today').notNull().default(0),
  app_usage_day: text('app_usage_day'),
  failed_calls_today: integer('failed_calls_today').notNull().default(0),
  failed_calls_day: text('failed_calls_day'),
  app_tokens_after_observation: integer('app_tokens_after_observation').notNull().default(0),
  reserved_tokens: integer('reserved_tokens').notNull().default(0),
});

export const inception_provider_reservations = sqliteTable('inception_provider_reservations', {
  reservation_id: text('reservation_id').primaryKey(),
  provider_id: text('provider_id').notNull(),
  tokens: integer('tokens').notNull(),
  created_at: integer('created_at').notNull(),
  expires_at: integer('expires_at').notNull(),
  round_id: text('round_id').references(() => rounds.id, { onDelete: 'set null' }),
});
