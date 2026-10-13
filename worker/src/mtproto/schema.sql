CREATE TABLE IF NOT EXISTS telegram_session (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  ciphertext TEXT,
  lock_owner TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO telegram_session (id) VALUES ('primary');

CREATE TABLE IF NOT EXISTS relay_state (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  forced TEXT CHECK (forced IN ('rwitc', 'turbosportslive') OR forced IS NULL),
  auto_start INTEGER NOT NULL DEFAULT 1 CHECK (auto_start IN (0, 1)),
  selected_chat_id INTEGER CHECK (selected_chat_id IS NULL OR selected_chat_id > 0),
  updated_at INTEGER NOT NULL DEFAULT 0
);
