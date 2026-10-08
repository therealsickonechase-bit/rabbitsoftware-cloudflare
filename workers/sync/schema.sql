-- Schema of rabbitsoftware-sync D1, exported from live 2026-10-08 (no data).
CREATE TABLE training_answers (
  id           TEXT PRIMARY KEY,                       
  shared_at    TEXT NOT NULL,                          
  question     TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  answer       TEXT NOT NULL CHECK (length(answer) BETWEEN 1 AND 4000),
  sources      TEXT NOT NULL DEFAULT '[]',             
  rating       INTEGER NOT NULL CHECK (rating IN (-1, 0, 1)),
  model        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_at  TEXT,
  exported_in  TEXT REFERENCES exports(file)           
);
CREATE INDEX training_by_status ON training_answers (status, shared_at);
CREATE INDEX training_unexported ON training_answers (exported_in, shared_at);
CREATE TABLE corpus_records (
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  title         TEXT NOT NULL,
  abstract      TEXT NOT NULL DEFAULT '',
  source_url    TEXT NOT NULL,
  published_at  TEXT NOT NULL DEFAULT '',
  batch         TEXT NOT NULL,                         
  added_at      TEXT NOT NULL,
  PRIMARY KEY (source, external_id)
);
CREATE INDEX corpus_by_added ON corpus_records (added_at);
CREATE TABLE exports (
  file        TEXT PRIMARY KEY,                        
  created_at  TEXT NOT NULL,
  rows        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  hf_commit   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE account_migration_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT NOT NULL CHECK (length(account_id) = 32),
  device_id       TEXT NOT NULL CHECK (length(device_id) = 32),
  action          TEXT NOT NULL CHECK (action IN ('consent', 'revoke')),
  destination     TEXT NOT NULL,
  notice_version  TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX migration_events_by_account ON account_migration_events (account_id, id);
