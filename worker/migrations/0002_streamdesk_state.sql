CREATE TABLE IF NOT EXISTS streamdesk_state (
  name TEXT PRIMARY KEY CHECK(name IN ('controls','owned-call')),
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS streamdesk_lease (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
