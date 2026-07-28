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

// Multi-bubble turns: one model call (one generation_request) now yields 1-4
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
// and the only place the raw payload - which may contain private chat details -
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
  }
] satisfies readonly DatabaseMigration[];
