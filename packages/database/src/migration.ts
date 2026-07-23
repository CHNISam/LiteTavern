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
    CHECK (source_format IN ('CCV2_JSON', 'CCV2_PNG', 'CCV3_JSON', 'CCV3_PNG', 'INTERNAL')),
  source_spec_version VARCHAR(20),
  import_status VARCHAR(20) NOT NULL DEFAULT 'UPLOADED'
    CHECK (import_status IN ('UPLOADED', 'PARSING', 'READY', 'FAILED')),
  raw_object_key VARCHAR(500),
  checksum_sha256 VARCHAR(64),
  normalized_data JSONB,
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

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: MIGRATION_SQL
  }
] satisfies readonly DatabaseMigration[];
