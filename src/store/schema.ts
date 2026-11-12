export const SCHEMA_VERSION = "2";

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('file','session','snippet','url','event')),
  title_enc TEXT NOT NULL,
  body_enc TEXT,
  path_enc TEXT,
  content_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'indexer',
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_last_seen ON entities(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_updated ON entities(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_entities_content_hash ON entities(content_hash);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  UNIQUE(from_id, to_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  summary_enc TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  payload_enc TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);

-- Legacy token table kept for migration compatibility
CREATE TABLE IF NOT EXISTS search_terms (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  PRIMARY KEY (entity_id, term)
);

CREATE INDEX IF NOT EXISTS idx_search_terms_term ON search_terms(term);

-- FTS5 index over redacted plaintext (searchable locally; vault fields stay encrypted)
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  entity_id UNINDEXED,
  type UNINDEXED,
  title,
  body,
  path,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  title_enc TEXT NOT NULL,
  entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL
);
`;

export const MIGRATE_V2_SQL = `
-- Add content_hash if upgrading from v1
`;
