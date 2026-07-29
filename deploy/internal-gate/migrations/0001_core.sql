PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_user (
  user_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_identity (
  session_token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_user(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_app_identity_user
  ON app_identity(user_id);

CREATE TABLE IF NOT EXISTS character (
  character_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  normalized_data TEXT NOT NULL,
  source_metadata TEXT NOT NULL,
  source_card TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  raw_object_key TEXT,
  avatar_object_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_user(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_character_user_updated
  ON character(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation (
  conversation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, character_id),
  FOREIGN KEY (user_id) REFERENCES app_user(user_id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES character(character_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_user
  ON conversation(user_id);

CREATE TABLE IF NOT EXISTS message (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL CHECK (sequence_no > 0),
  role TEXT NOT NULL CHECK (role IN ('USER', 'ASSISTANT', 'EVENT')),
  content_text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence_no),
  FOREIGN KEY (conversation_id) REFERENCES conversation(conversation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_message_conversation_sequence
  ON message(conversation_id, sequence_no);
