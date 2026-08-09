PRAGMA foreign_keys = ON;

-- BYOK secrets remain in the browser. This table stores only the connection
-- metadata needed to render and select a browser-local credential.
CREATE TABLE IF NOT EXISTS model_configuration (
  model_configuration_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES app_user(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_configuration_user_updated
  ON model_configuration(user_id, updated_at DESC);
