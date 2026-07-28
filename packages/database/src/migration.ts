export const MIGRATION_SQL = String.raw`
CREATE TABLE IF NOT EXISTS app_user (
  user_id UUID PRIMARY KEY,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS app_user_identity (
  identity_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  identity_type VARCHAR(20) NOT NULL DEFAULT 'ANONYMOUS'
    CHECK (identity_type IN ('ANONYMOUS', 'ACCOUNT', 'OAUTH')),
  subject_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  UNIQUE(identity_type, subject_hash)
);
CREATE INDEX IF NOT EXISTS idx_identity_user ON app_user_identity(user_id);

CREATE TABLE IF NOT EXISTS agent_character (
  character_id UUID PRIMARY KEY,
  owner_user_id UUID REFERENCES app_user(user_id),
  visibility VARCHAR(20) NOT NULL DEFAULT 'PRIVATE'
    CHECK (visibility IN ('PRIVATE', 'PLATFORM')),
  name VARCHAR(200) NOT NULL,
  profile_summary TEXT,
  personality_summary TEXT,
  first_message TEXT,
  avatar_seed VARCHAR(100),
  avatar_object_key VARCHAR(500),
  active_card_version_id UUID,
  default_model_configuration_id UUID,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED', 'DELETED')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_character_owner ON agent_character(owner_user_id);

CREATE TABLE IF NOT EXISTS agent_character_card_version (
  card_version_id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES agent_character(character_id),
  version_no INTEGER NOT NULL,
  source_format VARCHAR(30) NOT NULL
    CHECK (source_format IN (
      'CCV1_JSON', 'CCV1_PNG',
      'CCV2_JSON', 'CCV2_PNG',
      'CCV3_JSON', 'CCV3_PNG',
      'INTERNAL'
    )),
  source_spec_version VARCHAR(20),
  import_status VARCHAR(20) NOT NULL DEFAULT 'UPLOADED'
    CHECK (import_status IN ('UPLOADED', 'PARSING', 'READY', 'FAILED')),
  raw_object_key VARCHAR(500),
  checksum_sha256 VARCHAR(64),
  normalized_data JSONB,
  passthrough_data JSONB NOT NULL DEFAULT '{"root":{},"data":{}}'::jsonb,
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  preserved_data JSONB,
  parser_version VARCHAR(30),
  warning_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_code VARCHAR(50),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(character_id, version_no)
);

CREATE TABLE IF NOT EXISTS chat_conversation (
  conversation_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  character_id UUID NOT NULL REFERENCES agent_character(character_id),
  title VARCHAR(200),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED', 'DELETED')),
  next_sequence_no BIGINT NOT NULL DEFAULT 1,
  next_turn_no BIGINT NOT NULL DEFAULT 1,
  last_message_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_conversation_user_last ON chat_conversation(user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_user_character ON chat_conversation(user_id, character_id, status);

CREATE TABLE IF NOT EXISTS model_configuration (
  model_configuration_id UUID PRIMARY KEY,
  user_id UUID REFERENCES app_user(user_id),
  configuration_scope VARCHAR(20) NOT NULL
    CHECK (configuration_scope IN ('PLATFORM', 'USER')),
  provider VARCHAR(50) NOT NULL,
  model_name VARCHAR(200) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  base_url VARCHAR(500) NOT NULL DEFAULT '',
  credential_mode VARCHAR(30) NOT NULL
    CHECK (credential_mode IN ('PLATFORM_MANAGED', 'BROWSER_LOCAL')),
  credential_id VARCHAR(100),
  settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  context_window INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'INVALID', 'DISABLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  CHECK (
    (configuration_scope = 'PLATFORM' AND credential_mode = 'PLATFORM_MANAGED' AND credential_id IS NULL)
    OR
    (configuration_scope = 'USER' AND credential_mode = 'BROWSER_LOCAL' AND credential_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_model_configuration_user ON model_configuration(user_id, status);

CREATE TABLE IF NOT EXISTS agent_generation_request (
  generation_request_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  conversation_id UUID NOT NULL REFERENCES chat_conversation(conversation_id),
  input_message_id UUID NOT NULL,
  model_configuration_id UUID REFERENCES model_configuration(model_configuration_id),
  usage_mode VARCHAR(20) NOT NULL CHECK (usage_mode IN ('PLATFORM', 'BYOK')),
  idempotency_key VARCHAR(100) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'GENERATING', 'CANCEL_REQUESTED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  prompt_version VARCHAR(50) NOT NULL,
  context_manifest_json JSONB,
  provider_request_id VARCHAR(200),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cancel_requested_at TIMESTAMPTZ,
  error_code VARCHAR(50),
  error_message TEXT,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_generation_conversation ON agent_generation_request(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_message (
  message_id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES chat_conversation(conversation_id),
  generation_request_id UUID UNIQUE REFERENCES agent_generation_request(generation_request_id),
  reply_to_message_id UUID REFERENCES chat_message(message_id),
  sequence_no BIGINT NOT NULL,
  turn_no BIGINT NOT NULL,
  variant_no INTEGER NOT NULL DEFAULT 0,
  role VARCHAR(20) NOT NULL CHECK (role IN ('USER', 'ASSISTANT', 'EVENT')),
  content_text TEXT,
  content_json JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'STREAMING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED')),
  is_active_variant BOOLEAN NOT NULL DEFAULT TRUE,
  token_count INTEGER,
  error_code VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(conversation_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS idx_message_conversation_sequence ON chat_message(conversation_id, sequence_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_assistant_variant
  ON chat_message(conversation_id, turn_no)
  WHERE role = 'ASSISTANT' AND is_active_variant = TRUE;

ALTER TABLE agent_generation_request
  DROP CONSTRAINT IF EXISTS fk_generation_input_message;
ALTER TABLE agent_generation_request
  ADD CONSTRAINT fk_generation_input_message
  FOREIGN KEY (input_message_id) REFERENCES chat_message(message_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS agent_session_summary (
  summary_id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES chat_conversation(conversation_id),
  version_no INTEGER NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'GENERATING'
    CHECK (status IN ('GENERATING', 'READY', 'FAILED', 'SUPERSEDED')),
  coverage_start_sequence_no BIGINT NOT NULL,
  coverage_end_sequence_no BIGINT NOT NULL,
  summary_text TEXT,
  state_json JSONB,
  token_count INTEGER,
  supersedes_summary_id UUID REFERENCES agent_session_summary(summary_id),
  error_code VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE(conversation_id, version_no)
);

CREATE TABLE IF NOT EXISTS agent_memory (
  memory_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  character_id UUID NOT NULL REFERENCES agent_character(character_id),
  conversation_id UUID REFERENCES chat_conversation(conversation_id),
  memory_scope VARCHAR(20) NOT NULL CHECK (memory_scope IN ('USER', 'SHARED')),
  memory_kind VARCHAR(30) NOT NULL DEFAULT 'OTHER'
    CHECK (memory_kind IN ('FACT', 'PREFERENCE', 'EXPERIENCE', 'COMMITMENT', 'CORRECTION', 'OTHER')),
  subject_key VARCHAR(200),
  content TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'CANDIDATE'
    CHECK (status IN ('CANDIDATE', 'ACTIVE', 'REJECTED', 'SUPERSEDED', 'DELETED')),
  confidence NUMERIC(4,3),
  importance SMALLINT NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  created_by VARCHAR(20) NOT NULL DEFAULT 'SYSTEM' CHECK (created_by IN ('SYSTEM', 'USER')),
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  superseded_by_memory_id UUID REFERENCES agent_memory(memory_id),
  last_recalled_at TIMESTAMPTZ,
  recall_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_memory_recall
  ON agent_memory(user_id, character_id, status, importance DESC);

CREATE TABLE IF NOT EXISTS agent_memory_source (
  memory_source_id UUID PRIMARY KEY,
  memory_id UUID NOT NULL REFERENCES agent_memory(memory_id),
  message_id UUID NOT NULL REFERENCES chat_message(message_id),
  relation_type VARCHAR(30) NOT NULL DEFAULT 'EXTRACTED_FROM'
    CHECK (relation_type IN ('EXTRACTED_FROM', 'CONFIRMED_BY', 'CORRECTED_BY')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(memory_id, message_id, relation_type)
);

CREATE TABLE IF NOT EXISTS agent_relationship (
  relationship_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  character_id UUID NOT NULL REFERENCES agent_character(character_id),
  summary_text TEXT,
  state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ,
  UNIQUE(user_id, character_id)
);

CREATE TABLE IF NOT EXISTS model_usage_ledger (
  usage_id UUID PRIMARY KEY,
  generation_request_id UUID NOT NULL UNIQUE,
  user_id UUID NOT NULL,
  usage_mode VARCHAR(20) NOT NULL CHECK (usage_mode IN ('PLATFORM', 'BYOK')),
  provider VARCHAR(50) NOT NULL,
  model_name VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'RESERVED'
    CHECK (status IN ('RESERVED', 'FINALIZED', 'REVERSED')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost NUMERIC(18,8),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finalized_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_usage_user_mode_created
  ON model_usage_ledger(user_id, usage_mode, created_at DESC);

CREATE TABLE IF NOT EXISTS system_postprocess_job (
  job_id UUID PRIMARY KEY,
  dedupe_key VARCHAR(150) NOT NULL UNIQUE,
  job_type VARCHAR(30) NOT NULL CHECK (job_type IN ('EXTRACT_MEMORY', 'UPDATE_SUMMARY')),
  generation_request_id UUID REFERENCES agent_generation_request(generation_request_id),
  conversation_id UUID NOT NULL REFERENCES chat_conversation(conversation_id),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'COMPLETED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  error_code VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS analytics_event (
  event_id UUID PRIMARY KEY,
  user_id UUID REFERENCES app_user(user_id),
  session_id VARCHAR(100),
  event_name VARCHAR(100) NOT NULL,
  source_channel VARCHAR(50),
  device_type VARCHAR(30),
  properties_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_analytics_event_name_created
  ON analytics_event(event_name, created_at DESC);
`;

export interface DatabaseMigration {
  version: number;
  name: string;
  sql: string;
}

const PROVIDER_CONNECTION_MIGRATION_SQL = String.raw`
CREATE TABLE provider_connection (
  connection_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  provider_id VARCHAR(80) NOT NULL,
  auth_method_id VARCHAR(100) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  status VARCHAR(30) NOT NULL
    CHECK (status IN (
      'connected', 'expired', 'revoked', 'unavailable', 'reconnect_required'
    )),
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at TIMESTAMPTZ,
  last_error_code VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_provider_connection_user
  ON provider_connection(user_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_provider_connection_provider
  ON provider_connection(user_id, provider_id)
  WHERE deleted_at IS NULL;

CREATE TABLE provider_credential_metadata (
  credential_ref VARCHAR(160) PRIMARY KEY,
  connection_id UUID NOT NULL UNIQUE
    REFERENCES provider_connection(connection_id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL
    CHECK (kind IN ('oauth', 'device_code', 'api_key', 'token', 'cli', 'local', 'custom')),
  store VARCHAR(30) NOT NULL
    CHECK (store IN ('os_keyring', 'external_cli', 'none')),
  version INTEGER NOT NULL CHECK (version > 0),
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE provider_model_catalog (
  connection_id UUID NOT NULL
    REFERENCES provider_connection(connection_id) ON DELETE CASCADE,
  model_id VARCHAR(240) NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (connection_id, model_id)
);

ALTER TABLE model_configuration
  ADD COLUMN connection_id UUID REFERENCES provider_connection(connection_id) ON DELETE SET NULL;
CREATE INDEX idx_model_configuration_connection
  ON model_configuration(connection_id)
  WHERE deleted_at IS NULL;
`;

const CHARACTER_CARD_MODEL_MIGRATION_SQL = String.raw`
ALTER TABLE agent_character
  ADD COLUMN IF NOT EXISTS avatar_object_key VARCHAR(500);

ALTER TABLE agent_character_card_version
  ADD COLUMN IF NOT EXISTS passthrough_data JSONB
    NOT NULL DEFAULT '{"root":{},"data":{}}'::jsonb;
ALTER TABLE agent_character_card_version
  ADD COLUMN IF NOT EXISTS source_metadata JSONB
    NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE agent_character_card_version
  DROP CONSTRAINT IF EXISTS agent_character_card_version_source_format_check;
ALTER TABLE agent_character_card_version
  ADD CONSTRAINT agent_character_card_version_source_format_check
  CHECK (source_format IN (
    'CCV1_JSON', 'CCV1_PNG',
    'CCV2_JSON', 'CCV2_PNG',
    'CCV3_JSON', 'CCV3_PNG',
    'INTERNAL'
  ));
`;

// Multi-bubble turns: one model call (one generation_request) now yields 1–4
// assistant messages, so the 1:1 UNIQUE on generation_request_id is dropped and a
// per-turn bubble ordinal is added. The partial unique index keeps bubble writes
// idempotent without affecting legacy single-bubble rows (turn_bubble_no IS NULL).
const MULTI_BUBBLE_TURN_MIGRATION_SQL = String.raw`
ALTER TABLE chat_message
  DROP CONSTRAINT IF EXISTS chat_message_generation_request_id_key;
CREATE INDEX IF NOT EXISTS idx_message_generation_request
  ON chat_message(generation_request_id)
  WHERE generation_request_id IS NOT NULL;
ALTER TABLE chat_message
  ADD COLUMN IF NOT EXISTS turn_bubble_no INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_turn_bubble
  ON chat_message(generation_request_id, turn_bubble_no)
  WHERE turn_bubble_no IS NOT NULL;
-- A turn now holds several active assistant bubbles sharing one turn_no, so the
-- one-active-assistant-per-turn index no longer holds. Uniqueness moves to the
-- (generation_request_id, turn_bubble_no) index above.
DROP INDEX IF EXISTS idx_one_active_assistant_variant;
`;

const FREE_QUOTA_ANALYTICS_MIGRATION_SQL = String.raw`
ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS free_quota_total INTEGER NOT NULL DEFAULT 30
    CHECK (free_quota_total >= 0),
  ADD COLUMN IF NOT EXISTS free_quota_remaining INTEGER NOT NULL DEFAULT 30
    CHECK (free_quota_remaining >= 0),
  ADD COLUMN IF NOT EXISTS free_quota_reserved INTEGER NOT NULL DEFAULT 0
    CHECK (free_quota_reserved >= 0),
  ADD COLUMN IF NOT EXISTS free_quota_granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS first_source_channel VARCHAR(50),
  ADD COLUMN IF NOT EXISTS first_campaign_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS attribution_set_at TIMESTAMPTZ;

ALTER TABLE app_user
  ADD CONSTRAINT app_user_free_quota_bounds
  CHECK (
    free_quota_remaining <= free_quota_total
    AND free_quota_reserved <= free_quota_remaining
  );

CREATE TABLE IF NOT EXISTS free_quota_ledger (
  quota_ledger_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  request_id VARCHAR(100),
  action_type VARCHAR(20) NOT NULL
    CHECK (action_type IN ('GRANT', 'RESERVE', 'CONSUME', 'ROLLBACK', 'FAILURE')),
  delta INTEGER NOT NULL,
  balance_before INTEGER NOT NULL CHECK (balance_before >= 0),
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  provider VARCHAR(50),
  model VARCHAR(200),
  status VARCHAR(20) NOT NULL
    CHECK (status IN ('GRANTED', 'RESERVED', 'FINALIZED', 'RELEASED', 'FAILED', 'ROLLED_BACK')),
  failure_code VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_free_quota_user_created
  ON free_quota_ledger(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_free_quota_single_grant
  ON free_quota_ledger(user_id)
  WHERE action_type = 'GRANT';
CREATE UNIQUE INDEX IF NOT EXISTS idx_free_quota_request_action
  ON free_quota_ledger(user_id, request_id, action_type)
  WHERE request_id IS NOT NULL;

INSERT INTO free_quota_ledger (
  quota_ledger_id, user_id, action_type, delta,
  balance_before, balance_after, status, created_at
)
SELECT
  user_id, user_id, 'GRANT', free_quota_total,
  0, free_quota_remaining, 'GRANTED', free_quota_granted_at
FROM app_user
ON CONFLICT (quota_ledger_id) DO NOTHING;

ALTER TABLE agent_generation_request
  ADD COLUMN IF NOT EXISTS provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS model_name VARCHAR(200),
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS provider_attempts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS client_session_id VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_generation_user_status_completed
  ON agent_generation_request(user_id, status, completed_at);
CREATE INDEX IF NOT EXISTS idx_generation_session_created
  ON agent_generation_request(client_session_id, created_at)
  WHERE client_session_id IS NOT NULL;

ALTER TABLE analytics_event
  ADD COLUMN IF NOT EXISTS anonymous_id UUID,
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS page_name VARCHAR(80),
  ADD COLUMN IF NOT EXISTS page_path VARCHAR(500),
  ADD COLUMN IF NOT EXISTS character_id UUID,
  ADD COLUMN IF NOT EXISTS conversation_id UUID,
  ADD COLUMN IF NOT EXISTS campaign_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1;

UPDATE analytics_event
SET occurred_at = created_at, received_at = created_at
WHERE occurred_at IS NULL OR received_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_analytics_anonymous_occurred
  ON analytics_event(anonymous_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_user_occurred
  ON analytics_event(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_session_occurred
  ON analytics_event(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_analytics_source_occurred
  ON analytics_event(source_channel, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_event_occurred
  ON analytics_event(event_name, occurred_at DESC);
`;

// Email verification-code auth: registration and login share one primitive
// (email + 6-digit code). A verified email either upgrades the current anonymous
// user in place (new EMAIL identity, user_id preserved) or logs into an existing
// account and merges the anonymous data. Verification codes are stored hashed with
// an expiry, attempt cap and single-use flag; a merge audit row makes merges
// idempotent and traceable.
const EMAIL_AUTH_MIGRATION_SQL = String.raw`
ALTER TABLE app_user_identity
  DROP CONSTRAINT IF EXISTS app_user_identity_identity_type_check;
ALTER TABLE app_user_identity
  ADD CONSTRAINT app_user_identity_identity_type_check
  CHECK (identity_type IN ('ANONYMOUS', 'ACCOUNT', 'OAUTH', 'EMAIL'));
ALTER TABLE app_user_identity
  ADD COLUMN IF NOT EXISTS email_normalized VARCHAR(320);

ALTER TABLE app_user
  DROP CONSTRAINT IF EXISTS app_user_status_check;
ALTER TABLE app_user
  ADD CONSTRAINT app_user_status_check
  CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETED', 'MERGED'));
ALTER TABLE app_user
  ADD COLUMN IF NOT EXISTS email VARCHAR(320),
  ADD COLUMN IF NOT EXISTS merged_into_user_id UUID REFERENCES app_user(user_id);

CREATE TABLE IF NOT EXISTS auth_email_verification_code (
  code_id UUID PRIMARY KEY,
  email_normalized VARCHAR(320) NOT NULL,
  code_hash VARCHAR(64) NOT NULL,
  purpose VARCHAR(30) NOT NULL DEFAULT 'LOGIN'
    CHECK (purpose IN ('LOGIN')),
  session_identity_id UUID,
  request_ip VARCHAR(64),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_code_email_created
  ON auth_email_verification_code(email_normalized, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_code_ip_created
  ON auth_email_verification_code(request_ip, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_code_active
  ON auth_email_verification_code(email_normalized)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_account_merge (
  merge_id UUID PRIMARY KEY,
  source_user_id UUID NOT NULL REFERENCES app_user(user_id),
  target_user_id UUID NOT NULL REFERENCES app_user(user_id),
  merge_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (merge_status IN ('PENDING', 'COMPLETED', 'FAILED')),
  error_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE(source_user_id)
);
`;

// Relationship migration from other AI platforms. The user's own external model
// produces a standard JSON payload; PomChat only validates, previews and writes it
// into the existing character / relationship / memory models. `relationship_import`
// is deliberately thin: it is the audit + idempotency record (one commit per row)
// and the only place the raw payload — which may contain private chat details —
// is retained. `agent_memory.relationship_import_id` lets a user who deletes a
// migration record optionally take the memories it wrote with it.
const RELATIONSHIP_IMPORT_MIGRATION_SQL = String.raw`
CREATE TABLE IF NOT EXISTS relationship_import (
  import_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  target_character_id UUID REFERENCES agent_character(character_id),
  conversation_id UUID REFERENCES chat_conversation(conversation_id),
  schema_version VARCHAR(60) NOT NULL,
  source_platform VARCHAR(80),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  normalized_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  memory_count INTEGER NOT NULL DEFAULT 0 CHECK (memory_count >= 0),
  created_character BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'VALIDATED'
    CHECK (status IN ('VALIDATED', 'COMMITTED', 'DISCARDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  committed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_relationship_import_user
  ON relationship_import(user_id, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE agent_memory
  ADD COLUMN IF NOT EXISTS relationship_import_id UUID
    REFERENCES relationship_import(import_id);
CREATE INDEX IF NOT EXISTS idx_memory_relationship_import
  ON agent_memory(relationship_import_id)
  WHERE relationship_import_id IS NOT NULL;
`;

// Minimal causal-world foundation. Canonical facts are append-only; later repair or
// correction is represented by another fact instead of rewriting history. Mutable
// character state is intentionally separate from facts, beliefs and relationship
// reasons so prompt assembly can label each category with the right authority.
const CAUSAL_WORLD_FOUNDATION_MIGRATION_SQL = String.raw`
CREATE TABLE IF NOT EXISTS world_instance (
  world_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  character_id UUID NOT NULL REFERENCES agent_character(character_id),
  title VARCHAR(200),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, character_id)
);
CREATE INDEX IF NOT EXISTS idx_world_user_updated
  ON world_instance(user_id, updated_at DESC);

ALTER TABLE chat_conversation
  ADD COLUMN IF NOT EXISTS world_id UUID REFERENCES world_instance(world_id);
CREATE INDEX IF NOT EXISTS idx_conversation_world
  ON chat_conversation(world_id)
  WHERE world_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS world_fact (
  fact_id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES world_instance(world_id),
  fact_type VARCHAR(50) NOT NULL,
  actor_key VARCHAR(120) NOT NULL,
  target_key VARCHAR(120),
  scene_key VARCHAR(120),
  summary TEXT NOT NULL,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_message_id UUID REFERENCES chat_message(message_id),
  reversibility VARCHAR(20) NOT NULL
    CHECK (reversibility IN ('IRREVERSIBLE', 'COMPENSATABLE')),
  supersedes_fact_id UUID REFERENCES world_fact(fact_id)
);
CREATE INDEX IF NOT EXISTS idx_world_fact_timeline
  ON world_fact(world_id, occurred_at, recorded_at);

CREATE TABLE IF NOT EXISTS character_knowledge (
  knowledge_id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES world_instance(world_id),
  character_id UUID NOT NULL REFERENCES agent_character(character_id),
  fact_id UUID NOT NULL REFERENCES world_fact(fact_id),
  certainty VARCHAR(20) NOT NULL
    CHECK (certainty IN ('KNOWN', 'SUSPECTED', 'MISUNDERSTOOD')),
  interpretation TEXT NOT NULL,
  learned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(world_id, character_id, fact_id)
);
CREATE INDEX IF NOT EXISTS idx_character_knowledge_world
  ON character_knowledge(world_id, character_id, learned_at);

CREATE TABLE IF NOT EXISTS character_world_state (
  world_id UUID NOT NULL REFERENCES world_instance(world_id),
  character_id UUID NOT NULL REFERENCES agent_character(character_id),
  current_goal TEXT,
  current_plan TEXT,
  emotion_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  relationship_dimensions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (world_id, character_id)
);

CREATE TABLE IF NOT EXISTS relationship_change (
  relationship_change_id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES world_instance(world_id),
  character_id UUID NOT NULL REFERENCES agent_character(character_id),
  reason_fact_id UUID NOT NULL REFERENCES world_fact(fact_id),
  dimension_delta_json JSONB NOT NULL,
  reason TEXT NOT NULL,
  unresolved BOOLEAN NOT NULL DEFAULT FALSE,
  repairs_change_id UUID REFERENCES relationship_change(relationship_change_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_relationship_change_world
  ON relationship_change(world_id, character_id, created_at);

CREATE TABLE IF NOT EXISTS character_decision (
  decision_id UUID PRIMARY KEY,
  world_id UUID NOT NULL REFERENCES world_instance(world_id),
  character_id UUID NOT NULL REFERENCES agent_character(character_id),
  decision_key VARCHAR(120) NOT NULL,
  outcome_key VARCHAR(120) NOT NULL,
  rationale TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  presentation_message_id UUID REFERENCES chat_message(message_id),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_character_decision_world
  ON character_decision(world_id, character_id, decided_at);

CREATE TABLE IF NOT EXISTS character_decision_fact (
  decision_id UUID NOT NULL REFERENCES character_decision(decision_id),
  fact_id UUID NOT NULL REFERENCES world_fact(fact_id),
  PRIMARY KEY (decision_id, fact_id)
);

CREATE OR REPLACE FUNCTION reject_world_fact_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'world_fact is append-only; record a new fact instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_world_fact_append_only ON world_fact;
CREATE TRIGGER trg_world_fact_append_only
BEFORE UPDATE OR DELETE ON world_fact
FOR EACH ROW EXECUTE FUNCTION reject_world_fact_mutation();
`;

// LiteTavern Cloud Alpha program. The client (LiteTavern) stays open-source and
// BYOK-capable; everything here belongs to the hosted service: which stage a user is
// in, which Alpha batch released them, what their current quota cycle is, and what
// each model call actually cost. Deliberately reuses the existing facts instead of
// re-storing them — registration still lives in app_user/app_user_identity and the
// one-time Trial balance still lives in app_user.free_quota_* + free_quota_ledger.
//
// cloud_membership is the single row describing "where is this user in the program".
// alpha_batch owns capacity and quota policy (never hardcoded in application code).
// alpha_grant is the idempotent audit of a release; a partial unique index makes a
// second concurrent release for the same user a no-op instead of a duplicate grant.
// cloud_quota_cycle stores explicit start/end instants, so no "calendar month" or
// "anniversary" rule is baked into the schema.
const CLOUD_ALPHA_PROGRAM_MIGRATION_SQL = String.raw`
CREATE TABLE IF NOT EXISTS alpha_batch (
  batch_id UUID PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'PAUSED', 'CLOSED')),
  -- {cycle_replies, cycle_days, carry_over, max_units_per_request,
  --  daily_unit_limit, user_rate_limit_per_minute, model_multipliers:{}}
  quota_policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  budget_limit_usd NUMERIC(18,6),
  notes TEXT,
  created_by VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_alpha_batch_status
  ON alpha_batch(status, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_membership (
  user_id UUID PRIMARY KEY REFERENCES app_user(user_id),
  membership_status VARCHAR(30) NOT NULL DEFAULT 'ANONYMOUS_TRIAL'
    CHECK (membership_status IN (
      'ANONYMOUS_TRIAL', 'REGISTERED_WAITLIST',
      'ALPHA_ACTIVE', 'ALPHA_PAUSED', 'ALPHA_ENDED'
    )),
  waitlist_joined_at TIMESTAMPTZ,
  waitlist_channel VARCHAR(50),
  batch_id UUID REFERENCES alpha_batch(batch_id),
  grant_source VARCHAR(30)
    CHECK (grant_source IN (
      'SUPPORTER_PRIORITY', 'WAITLIST', 'DIRECT_INVITE', 'ADMIN_GRANT'
    )),
  granted_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cloud_membership_waitlist
  ON cloud_membership(membership_status, waitlist_joined_at)
  WHERE membership_status = 'REGISTERED_WAITLIST';
CREATE INDEX IF NOT EXISTS idx_cloud_membership_batch
  ON cloud_membership(batch_id)
  WHERE batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS alpha_grant (
  grant_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  batch_id UUID NOT NULL REFERENCES alpha_batch(batch_id),
  grant_source VARCHAR(30) NOT NULL
    CHECK (grant_source IN (
      'SUPPORTER_PRIORITY', 'WAITLIST', 'DIRECT_INVITE', 'ADMIN_GRANT'
    )),
  status VARCHAR(20) NOT NULL DEFAULT 'GRANTED'
    CHECK (status IN ('GRANTED', 'REVOKED')),
  waited_seconds BIGINT,
  granted_by VARCHAR(120),
  revoked_reason VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ
);
-- A user can hold at most one live Alpha grant; concurrent releases collide here
-- instead of double-granting.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alpha_grant_active_user
  ON alpha_grant(user_id)
  WHERE status = 'GRANTED';
CREATE INDEX IF NOT EXISTS idx_alpha_grant_batch
  ON alpha_grant(batch_id, created_at);

CREATE TABLE IF NOT EXISTS founding_supporter (
  user_id UUID PRIMARY KEY REFERENCES app_user(user_id),
  display_name VARCHAR(120),
  anonymous BOOLEAN NOT NULL DEFAULT TRUE,
  external_reference VARCHAR(200),
  marked_by VARCHAR(120),
  note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_founding_supporter_reference
  ON founding_supporter(external_reference)
  WHERE external_reference IS NOT NULL;

-- One quota period. start/end are explicit instants: no calendar rule is encoded.
-- granted_units is the allowance; reserved/consumed move only through
-- cloud_quota_ledger, and the CHECK keeps concurrency from going negative.
CREATE TABLE IF NOT EXISTS cloud_quota_cycle (
  cycle_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  quota_source VARCHAR(20) NOT NULL DEFAULT 'ALPHA'
    CHECK (quota_source IN ('ALPHA')),
  batch_id UUID REFERENCES alpha_batch(batch_id),
  grant_id UUID REFERENCES alpha_grant(grant_id),
  cycle_no INTEGER NOT NULL CHECK (cycle_no > 0),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  granted_units INTEGER NOT NULL CHECK (granted_units >= 0),
  carried_units INTEGER NOT NULL DEFAULT 0 CHECK (carried_units >= 0),
  consumed_units INTEGER NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (ends_at > starts_at),
  CHECK (consumed_units + reserved_units <= granted_units + carried_units),
  UNIQUE (user_id, quota_source, cycle_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_quota_cycle_active
  ON cloud_quota_cycle(user_id, quota_source)
  WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_cloud_quota_cycle_batch
  ON cloud_quota_cycle(batch_id, starts_at);

CREATE TABLE IF NOT EXISTS cloud_quota_ledger (
  quota_ledger_id UUID PRIMARY KEY,
  cycle_id UUID NOT NULL REFERENCES cloud_quota_cycle(cycle_id),
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  request_id VARCHAR(100),
  action_type VARCHAR(20) NOT NULL
    CHECK (action_type IN ('GRANT', 'RESERVE', 'CONSUME', 'RELEASE')),
  units INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  provider VARCHAR(50),
  model VARCHAR(200),
  failure_code VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cloud_quota_ledger_cycle
  ON cloud_quota_ledger(cycle_id, created_at DESC);
-- One row per (cycle, request, action) makes reserve/consume/release replay-safe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_quota_ledger_request_action
  ON cloud_quota_ledger(cycle_id, request_id, action_type)
  WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_quota_ledger_single_grant
  ON cloud_quota_ledger(cycle_id)
  WHERE action_type = 'GRANT';

-- Real cost accounting. model_usage_ledger already records one row per generation
-- request; these columns turn it into the cost book (which quota paid, which cycle,
-- which post-processing stage, what it actually cost in money).
ALTER TABLE model_usage_ledger
  ADD COLUMN IF NOT EXISTS quota_source VARCHAR(20) NOT NULL DEFAULT 'BYOK'
    CHECK (quota_source IN ('TRIAL', 'ALPHA', 'BYOK', 'NONE')),
  ADD COLUMN IF NOT EXISTS cycle_id UUID REFERENCES cloud_quota_cycle(cycle_id),
  ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES alpha_batch(batch_id),
  ADD COLUMN IF NOT EXISTS conversation_id UUID,
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(30) NOT NULL DEFAULT 'MAIN_REPLY'
    CHECK (purpose IN (
      'MAIN_REPLY', 'SUMMARY', 'MEMORY', 'RELATIONSHIP',
      'SUGGESTION', 'OTHER'
    )),
  ADD COLUMN IF NOT EXISTS cached_input_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS quota_units INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_cost_usd NUMERIC(18,8);

-- Backfill: every ledger row written before this migration came from the
-- PLATFORM (Trial) path or a BYOK call, and all of them were main replies.
UPDATE model_usage_ledger
SET quota_source = CASE WHEN usage_mode = 'PLATFORM' THEN 'TRIAL' ELSE 'BYOK' END,
    quota_units = CASE WHEN usage_mode = 'PLATFORM' THEN 1 ELSE 0 END
WHERE quota_source = 'BYOK' AND usage_mode = 'PLATFORM';

-- One model call per (request, purpose): the main reply, the summary, the memory
-- extraction and the relationship update each get their own cost row, so per-stage
-- cost is visible instead of being collapsed into a single number.
ALTER TABLE model_usage_ledger
  DROP CONSTRAINT IF EXISTS model_usage_ledger_generation_request_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_request_purpose
  ON model_usage_ledger(generation_request_id, purpose);

CREATE INDEX IF NOT EXISTS idx_usage_quota_source_created
  ON model_usage_ledger(quota_source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_batch_created
  ON model_usage_ledger(batch_id, created_at DESC)
  WHERE batch_id IS NOT NULL;

-- Existing users predate the program: anonymous ones are on Trial, registered ones
-- are already on the waitlist (registration alone never grants Alpha).
INSERT INTO cloud_membership (
  user_id, membership_status, waitlist_joined_at, created_at
)
SELECT user_id,
       CASE WHEN email IS NULL THEN 'ANONYMOUS_TRIAL' ELSE 'REGISTERED_WAITLIST' END,
       CASE WHEN email IS NULL THEN NULL ELSE created_at END,
       created_at
FROM app_user
WHERE status = 'ACTIVE'
ON CONFLICT (user_id) DO NOTHING;

-- Cloud sync checkpoints. The API is the store of record for characters,
-- conversations and messages, so "sync" here is the per-device acknowledgement of
-- how far a client has reconciled, plus the failure state a client can retry from.
CREATE TABLE IF NOT EXISTS cloud_sync_state (
  sync_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_user(user_id),
  device_key VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'SYNCED'
    CHECK (status IN ('LOCAL', 'SYNCING', 'SYNCED', 'FAILED')),
  last_synced_at TIMESTAMPTZ,
  last_client_revision BIGINT NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  last_error_code VARCHAR(80),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, device_key)
);

CREATE TABLE IF NOT EXISTS cloud_backup_job (
  backup_job_id UUID PRIMARY KEY,
  job_kind VARCHAR(20) NOT NULL CHECK (job_kind IN ('BACKUP', 'RESTORE')),
  scope VARCHAR(30) NOT NULL DEFAULT 'DATABASE'
    CHECK (scope IN ('DATABASE', 'ASSETS')),
  status VARCHAR(20) NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'VERIFIED')),
  artifact_uri VARCHAR(500),
  checksum_sha256 VARCHAR(64),
  size_bytes BIGINT,
  -- A backup counts as successful only once a restore of it has been verified.
  verified_at TIMESTAMPTZ,
  verification_note VARCHAR(300),
  error_code VARCHAR(80),
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_backup_job_started
  ON cloud_backup_job(job_kind, started_at DESC);
`;

// Alpha capacity plan for LiteTavern Cloud v0.1.0.
//
// The v9 program already owns per-batch capacity. What it deliberately did not have
// was a *program-level* ceiling, because Alpha was described as open-ended. The
// v0.1.0 operating decision changes that: 30 seats total for this stage, released in
// two waves (10 then 20), and the second wave is unlocked by an operator only after
// the first wave is demonstrably digested — never on a date.
//
// alpha_program_plan is that ceiling. `released_capacity` — not `total_capacity` — is
// what a grant is checked against, which is how "10 now, 30 only after unlock" is
// enforced in one place instead of being scattered through application code.
//
// alpha_feedback and alpha_blocker exist because the repository had no feedback or
// issue register at all. They are deliberately thin: a feedback row must reach a
// disposition, and a blocker must reach a verified close. There is no approval
// workflow, no state machine engine and no assignment model — 30 testers do not
// justify one.
//
// Nothing here re-stores a fact that already exists. Effective testers and stable
// core sessions are *computed* from app_user, cloud_membership, chat_message,
// agent_generation_request, cloud_quota_ledger and model_usage_ledger; only the
// operator's own judgement (a disposition, a blocker close, a cost confirmation)
// is new state, because nothing else can derive it.
const ALPHA_CAPACITY_PLAN_MIGRATION_SQL = String.raw`
-- Split "has a seat" from "has actually started testing". A single boolean cannot
-- express that difference, and the release/activation gap is exactly what the
-- effective-tester count is about.
ALTER TABLE cloud_membership
  DROP CONSTRAINT IF EXISTS cloud_membership_membership_status_check;
ALTER TABLE cloud_membership
  ADD CONSTRAINT cloud_membership_membership_status_check
  CHECK (membership_status IN (
    'ANONYMOUS_TRIAL', 'REGISTERED_WAITLIST', 'ALPHA_GRANTED',
    'ALPHA_ACTIVE', 'ALPHA_PAUSED', 'ALPHA_ENDED'
  ));
ALTER TABLE cloud_membership
  ADD COLUMN IF NOT EXISTS revoked_reason VARCHAR(300),
  ADD COLUMN IF NOT EXISTS priority_rank INTEGER,
  ADD COLUMN IF NOT EXISTS supporter_priority BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill the new flag from the existing supporter table rather than asking an
-- operator to re-enter it.
UPDATE cloud_membership m
SET supporter_priority = TRUE
FROM founding_supporter s
WHERE s.user_id = m.user_id AND m.supporter_priority = FALSE;

-- Which wave a batch belongs to. Nullable: batches created before this migration
-- predate the two-wave plan and are treated as wave 1.
ALTER TABLE alpha_batch
  ADD COLUMN IF NOT EXISTS batch_no INTEGER CHECK (batch_no > 0);
UPDATE alpha_batch SET batch_no = 1 WHERE batch_no IS NULL;

ALTER TABLE alpha_grant
  ADD COLUMN IF NOT EXISTS batch_no INTEGER CHECK (batch_no > 0),
  ADD COLUMN IF NOT EXISTS reclaimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reclaimed_by VARCHAR(120);
UPDATE alpha_grant SET batch_no = 1 WHERE batch_no IS NULL;

-- The program ceiling. One row per plan key; v0.1.0 ships exactly one.
CREATE TABLE IF NOT EXISTS alpha_program_plan (
  plan_key VARCHAR(60) PRIMARY KEY,
  total_capacity INTEGER NOT NULL CHECK (total_capacity > 0),
  batch_1_capacity INTEGER NOT NULL CHECK (batch_1_capacity > 0),
  batch_2_capacity INTEGER NOT NULL CHECK (batch_2_capacity >= 0),
  released_capacity INTEGER NOT NULL CHECK (released_capacity >= 0),
  current_batch_no INTEGER NOT NULL DEFAULT 1 CHECK (current_batch_no > 0),
  batch_2_unlocked BOOLEAN NOT NULL DEFAULT FALSE,
  batch_2_unlocked_at TIMESTAMPTZ,
  batch_2_unlocked_by VARCHAR(120),
  -- The checklist result and metric snapshot at the moment of unlock. Kept so the
  -- decision stays auditable after the underlying numbers have moved on.
  unlock_evidence_json JSONB,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  paused_reason VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (released_capacity <= total_capacity),
  CHECK (batch_1_capacity + batch_2_capacity <= total_capacity),
  -- Locked means at most wave 1 is released; unlocked means the full ceiling is.
  CHECK (
    (batch_2_unlocked = FALSE AND released_capacity <= batch_1_capacity)
    OR batch_2_unlocked = TRUE
  ),
  CHECK (
    (batch_2_unlocked = TRUE AND batch_2_unlocked_at IS NOT NULL)
    OR batch_2_unlocked = FALSE
  )
);

-- v0.1.0 stage-1 plan. Seeded here rather than hardcoded in application code or the
-- browser, so an operator can adjust it without a deploy.
INSERT INTO alpha_program_plan (
  plan_key, total_capacity, batch_1_capacity, batch_2_capacity,
  released_capacity, current_batch_no, batch_2_unlocked
) VALUES ('v0.1.0', 30, 10, 20, 10, 1, FALSE)
ON CONFLICT (plan_key) DO NOTHING;

-- Feedback register. "Digested" is defined structurally: a row is settled only when
-- it is classified AND has a disposition (or is linked to the duplicate that carries
-- them). Anything else is, by construction, still outstanding.
CREATE TABLE IF NOT EXISTS alpha_feedback (
  feedback_id UUID PRIMARY KEY,
  user_id UUID REFERENCES app_user(user_id),
  batch_no INTEGER CHECK (batch_no > 0),
  title VARCHAR(200) NOT NULL,
  detail TEXT,
  source VARCHAR(30) NOT NULL DEFAULT 'ALPHA_USER'
    CHECK (source IN ('ALPHA_USER', 'OPERATOR', 'AUTOMATED')),
  -- NULL until an operator classifies it: an unclassified row blocks the gate.
  category VARCHAR(40)
    CHECK (category IN (
      'BUG', 'UX', 'PERFORMANCE', 'CONTENT_QUALITY',
      'BILLING_QUOTA', 'FEATURE_REQUEST', 'OTHER'
    )),
  severity VARCHAR(20) NOT NULL DEFAULT 'UNTRIAGED'
    CHECK (severity IN ('UNTRIAGED', 'BLOCKER', 'MAJOR', 'MINOR', 'ENHANCEMENT')),
  -- NULL until disposed of. These four are the only permitted conclusions.
  disposition VARCHAR(20)
    CHECK (disposition IN ('FIX_NOW', 'DEFER', 'REJECT', 'OBSERVE')),
  disposition_note VARCHAR(500),
  disposed_at TIMESTAMPTZ,
  disposed_by VARCHAR(120),
  -- Deduplication: the canonical row carries the classification and disposition.
  duplicate_of_feedback_id UUID REFERENCES alpha_feedback(feedback_id),
  blocker_id UUID,
  valid BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (duplicate_of_feedback_id IS NULL OR duplicate_of_feedback_id <> feedback_id),
  CHECK (
    (disposition IS NULL AND disposed_at IS NULL)
    OR (disposition IS NOT NULL AND disposed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_alpha_feedback_open
  ON alpha_feedback(batch_no, created_at)
  WHERE valid = TRUE AND duplicate_of_feedback_id IS NULL
    AND (category IS NULL OR disposition IS NULL);
CREATE INDEX IF NOT EXISTS idx_alpha_feedback_user
  ON alpha_feedback(user_id, created_at DESC);

-- Blocker register. The nine categories below are the product's definition of
-- "blocking"; anything else is a normal defect and does not hold up a release.
CREATE TABLE IF NOT EXISTS alpha_blocker (
  blocker_id UUID PRIMARY KEY,
  batch_no INTEGER CHECK (batch_no > 0),
  blocker_type VARCHAR(40) NOT NULL
    CHECK (blocker_type IN (
      'AUTH_FAILURE',           -- cannot register or log in
      'ALPHA_ENTRY_FAILURE',    -- has a seat but cannot enter Alpha
      'CHAT_UNAVAILABLE',       -- cannot start the core chat
      'QUOTA_MISCHARGE',        -- platform quota deducted wrongly
      'MODEL_CALL_FAILURE',     -- widespread model call failure
      'DATA_LOSS',
      'CROSS_USER_LEAK',        -- leak or privilege escalation across users
      'COST_RUNAWAY',
      'DATA_CORRUPTION'
    )),
  title VARCHAR(200) NOT NULL,
  detail TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'RESOLVED', 'VERIFIED', 'CLOSED')),
  detected_by VARCHAR(120),
  detection_source VARCHAR(30) NOT NULL DEFAULT 'OPERATOR'
    CHECK (detection_source IN ('OPERATOR', 'ALPHA_USER', 'AUTOMATED')),
  user_id UUID REFERENCES app_user(user_id),
  feedback_id UUID REFERENCES alpha_feedback(feedback_id),
  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Moves forward on every recurrence. This is the cutoff the consecutive-stable
  -- core-session counter measures from, so a recurrence resets that counter by
  -- construction rather than by a separate bookkeeping step.
  last_detected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (recurrence_count >= 0),
  resolved_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  verified_by VARCHAR(120),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A blocker only counts as closed once a fix has been verified.
  CHECK (status <> 'CLOSED' OR (resolved_at IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_alpha_blocker_unresolved
  ON alpha_blocker(status, last_detected_at DESC)
  WHERE status <> 'CLOSED';
CREATE INDEX IF NOT EXISTS idx_alpha_blocker_detected
  ON alpha_blocker(last_detected_at DESC);

ALTER TABLE alpha_feedback
  DROP CONSTRAINT IF EXISTS alpha_feedback_blocker_fk;
ALTER TABLE alpha_feedback
  ADD CONSTRAINT alpha_feedback_blocker_fk
  FOREIGN KEY (blocker_id) REFERENCES alpha_blocker(blocker_id);

-- The one gate item that cannot be computed. An operator states that current spend
-- and support load are manageable, and the metrics they saw are frozen alongside it
-- so the confirmation can never be read as a blanket approval.
CREATE TABLE IF NOT EXISTS alpha_readiness_confirmation (
  confirmation_id UUID PRIMARY KEY,
  plan_key VARCHAR(60) NOT NULL REFERENCES alpha_program_plan(plan_key),
  batch_no INTEGER NOT NULL CHECK (batch_no > 0),
  confirmed_by VARCHAR(120) NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note VARCHAR(500),
  metrics_snapshot_json JSONB NOT NULL,
  superseded_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_alpha_readiness_current
  ON alpha_readiness_confirmation(plan_key, batch_no, confirmed_at DESC)
  WHERE superseded_at IS NULL;

-- Audit for every capacity-affecting operator action. Append-only by convention;
-- the program is small enough that a plain log beats an event-sourced design.
CREATE TABLE IF NOT EXISTS alpha_capacity_audit (
  audit_id UUID PRIMARY KEY,
  plan_key VARCHAR(60) NOT NULL,
  action VARCHAR(40) NOT NULL
    CHECK (action IN (
      'GRANT', 'SUSPEND', 'RESUME', 'REVOKE', 'RECLAIM',
      'ACTIVATE', 'BATCH_2_UNLOCK', 'READINESS_CONFIRMED', 'PLAN_UPDATED'
    )),
  actor VARCHAR(120) NOT NULL,
  user_id UUID REFERENCES app_user(user_id),
  batch_no INTEGER,
  reason VARCHAR(300),
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_alpha_capacity_audit_created
  ON alpha_capacity_audit(plan_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alpha_capacity_audit_user
  ON alpha_capacity_audit(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
`;

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: MIGRATION_SQL
  },
  {
    version: 2,
    name: 'provider_connections',
    sql: PROVIDER_CONNECTION_MIGRATION_SQL
  },
  {
    version: 3,
    name: 'character_card_model',
    sql: CHARACTER_CARD_MODEL_MIGRATION_SQL
  },
  {
    version: 4,
    name: 'multi_bubble_turns',
    sql: MULTI_BUBBLE_TURN_MIGRATION_SQL
  },
  {
    version: 5,
    name: 'free_quota_analytics',
    sql: FREE_QUOTA_ANALYTICS_MIGRATION_SQL
  },
  {
    version: 6,
    name: 'email_auth',
    sql: EMAIL_AUTH_MIGRATION_SQL
  },
  {
    version: 7,
    name: 'relationship_import',
    sql: RELATIONSHIP_IMPORT_MIGRATION_SQL
  },
  {
    version: 8,
    name: 'causal_world_foundation',
    sql: CAUSAL_WORLD_FOUNDATION_MIGRATION_SQL
  },
  {
    version: 9,
    name: 'cloud_alpha_program',
    sql: CLOUD_ALPHA_PROGRAM_MIGRATION_SQL
  },
  {
    version: 10,
    name: 'alpha_capacity_plan',
    sql: ALPHA_CAPACITY_PLAN_MIGRATION_SQL
  }
] satisfies readonly DatabaseMigration[];
