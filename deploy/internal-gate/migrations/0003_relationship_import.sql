PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS relationship_import (
  import_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMMITTED')),
  payload TEXT NOT NULL,
  result TEXT,
  character_id TEXT,
  conversation_id TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT,
  FOREIGN KEY (user_id) REFERENCES app_user(user_id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES character(character_id) ON DELETE SET NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversation(conversation_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_relationship_import_user_created
  ON relationship_import(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS character_relationship (
  character_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  stage TEXT NOT NULL,
  user_addressing TEXT NOT NULL DEFAULT '[]',
  interaction_patterns TEXT NOT NULL DEFAULT '[]',
  user_profile TEXT NOT NULL,
  unfinished_threads TEXT NOT NULL DEFAULT '[]',
  source_metadata TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_user(user_id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES character(character_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory (
  memory_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_kind TEXT NOT NULL,
  importance INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 10),
  approximate_time TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  evidence_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (character_id, content),
  FOREIGN KEY (user_id) REFERENCES app_user(user_id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES character(character_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_character_importance
  ON memory(user_id, character_id, importance DESC, created_at DESC);
