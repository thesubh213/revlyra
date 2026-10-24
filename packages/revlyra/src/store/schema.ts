const COMMON_TABLES = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  policy_id TEXT NOT NULL DEFAULT 'balanced',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  rate_limit INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  mapping TEXT NOT NULL,
  cursor TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_tenant ON sources (tenant_id);

CREATE TABLE IF NOT EXISTS reviewers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  external_hmac TEXT NOT NULL,
  account_created_at TEXT,
  stats TEXT NOT NULL DEFAULT '{}',
  risk_score REAL NOT NULL DEFAULT 0,
  risk_band TEXT NOT NULL DEFAULT 'low',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE (tenant_id, external_hmac)
);
CREATE INDEX IF NOT EXISTS idx_reviewers_tenant ON reviewers (tenant_id, last_seen);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  external_hmac TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'product',
  category TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',
  stats TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, external_hmac)
);
CREATE INDEX IF NOT EXISTS idx_items_tenant ON items (tenant_id);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT 'api',
  external_hmac TEXT NOT NULL,
  item_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  rating REAL NOT NULL,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  simhash TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  submitted_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  context TEXT NOT NULL DEFAULT '{}',
  media TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'analyzed',
  score REAL,
  confidence REAL,
  decision TEXT,
  band TEXT,
  provisional INTEGER NOT NULL DEFAULT 0,
  analysis_hash TEXT,
  model_version TEXT,
  policy_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_id, external_hmac)
);
CREATE INDEX IF NOT EXISTS idx_reviews_tenant_time ON reviews (tenant_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews (tenant_id, reviewer_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_item ON reviews (tenant_id, item_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_sha ON reviews (tenant_id, text_sha256);

CREATE TABLE IF NOT EXISTS review_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  code TEXT NOT NULL,
  family TEXT NOT NULL,
  severity REAL NOT NULL,
  confidence REAL NOT NULL,
  contribution REAL NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  explanation TEXT NOT NULL,
  hard INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_signals_review ON review_signals (review_id);

CREATE TABLE IF NOT EXISTS text_index (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  simhash TEXT NOT NULL,
  minhash TEXT NOT NULL,
  review_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, review_id)
);
CREATE INDEX IF NOT EXISTS idx_text_sha ON text_index (tenant_id, text_sha256);

CREATE TABLE IF NOT EXISTS text_bands (
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  band_key TEXT NOT NULL,
  text_index_id TEXT NOT NULL,
  PRIMARY KEY (kind, band_key, text_index_id)
);
CREATE INDEX IF NOT EXISTS idx_text_bands_lookup ON text_bands (tenant_id, kind, band_key);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  sha256 TEXT,
  dhash TEXT,
  phash TEXT,
  width INTEGER,
  height INTEGER,
  mime TEXT,
  exif TEXT NOT NULL DEFAULT '{}',
  url_hmac TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_sha ON media (tenant_id, sha256);
CREATE INDEX IF NOT EXISTS idx_media_review ON media (review_id);

CREATE TABLE IF NOT EXISTS media_bands (
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  band_key TEXT NOT NULL,
  media_id TEXT NOT NULL,
  PRIMARY KEY (kind, band_key, media_id)
);
CREATE INDEX IF NOT EXISTS idx_media_bands_lookup ON media_bands (tenant_id, kind, band_key);

CREATE TABLE IF NOT EXISTS reviewer_item_edges (
  tenant_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  risk REAL NOT NULL DEFAULT 0,
  signals TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, review_id)
);
CREATE INDEX IF NOT EXISTS idx_edges_tenant_time ON reviewer_item_edges (tenant_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_edges_item ON reviewer_item_edges (tenant_id, item_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  score REAL NOT NULL,
  density REAL NOT NULL,
  member_count INTEGER NOT NULL,
  reviewer_ids TEXT NOT NULL,
  item_ids TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns (tenant_id, score DESC);

CREATE TABLE IF NOT EXISTS campaign_members (
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, campaign_id, reviewer_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_members_reviewer ON campaign_members (tenant_id, reviewer_id);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  label TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  notes TEXT,
  actor_hmac TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_review ON feedback (tenant_id, review_id);

CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reason TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolver_hmac TEXT,
  sla_due_at TEXT,
  handler_hmac TEXT,
  outcome_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals (tenant_id, status);

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  type TEXT NOT NULL,
  claim TEXT NOT NULL,
  substantiated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notices_tenant ON notices (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_notices_review ON notices (tenant_id, review_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TEXT NOT NULL,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, run_after, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log (tenant_id, seq);

CREATE TABLE IF NOT EXISTS usage_counters (
  tenant_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  period TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, metric, period)
);

CREATE TABLE IF NOT EXISTS risk_snapshots (
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (tenant_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS model_versions (
  version TEXT PRIMARY KEY,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_versions (
  tenant_id TEXT NOT NULL,
  version TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, version)
);
`;

export const SQLITE_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
${COMMON_TABLES}
`;

export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  policy_id TEXT NOT NULL DEFAULT 'balanced',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  rate_limit INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  mapping TEXT NOT NULL,
  cursor TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_tenant ON sources (tenant_id);

CREATE TABLE IF NOT EXISTS reviewers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  external_hmac TEXT NOT NULL,
  account_created_at TEXT,
  stats TEXT NOT NULL DEFAULT '{}',
  risk_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  risk_band TEXT NOT NULL DEFAULT 'low',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE (tenant_id, external_hmac)
);
CREATE INDEX IF NOT EXISTS idx_reviewers_tenant ON reviewers (tenant_id, last_seen);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  external_hmac TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'product',
  category TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',
  stats TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, external_hmac)
);
CREATE INDEX IF NOT EXISTS idx_items_tenant ON items (tenant_id);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT 'api',
  external_hmac TEXT NOT NULL,
  item_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  rating DOUBLE PRECISION NOT NULL,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  simhash TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'und',
  submitted_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  context TEXT NOT NULL DEFAULT '{}',
  media TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'analyzed',
  score DOUBLE PRECISION,
  confidence DOUBLE PRECISION,
  decision TEXT,
  band TEXT,
  provisional BOOLEAN NOT NULL DEFAULT FALSE,
  analysis_hash TEXT,
  model_version TEXT,
  policy_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_id, external_hmac)
);
CREATE INDEX IF NOT EXISTS idx_reviews_tenant_time ON reviews (tenant_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer ON reviews (tenant_id, reviewer_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_item ON reviews (tenant_id, item_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_sha ON reviews (tenant_id, text_sha256);

CREATE TABLE IF NOT EXISTS review_signals (
  id BIGSERIAL PRIMARY KEY,
  review_id TEXT NOT NULL,
  code TEXT NOT NULL,
  family TEXT NOT NULL,
  severity DOUBLE PRECISION NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  contribution DOUBLE PRECISION NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  explanation TEXT NOT NULL,
  hard BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_signals_review ON review_signals (review_id);

CREATE TABLE IF NOT EXISTS text_index (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  simhash TEXT NOT NULL,
  minhash TEXT NOT NULL,
  review_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, review_id)
);
CREATE INDEX IF NOT EXISTS idx_text_sha ON text_index (tenant_id, text_sha256);

CREATE TABLE IF NOT EXISTS text_bands (
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  band_key TEXT NOT NULL,
  text_index_id TEXT NOT NULL,
  PRIMARY KEY (kind, band_key, text_index_id)
);
CREATE INDEX IF NOT EXISTS idx_text_bands_lookup ON text_bands (tenant_id, kind, band_key);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  sha256 TEXT,
  dhash TEXT,
  phash TEXT,
  width INTEGER,
  height INTEGER,
  mime TEXT,
  exif TEXT NOT NULL DEFAULT '{}',
  url_hmac TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_sha ON media (tenant_id, sha256);
CREATE INDEX IF NOT EXISTS idx_media_review ON media (review_id);

CREATE TABLE IF NOT EXISTS media_bands (
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  band_key TEXT NOT NULL,
  media_id TEXT NOT NULL,
  PRIMARY KEY (kind, band_key, media_id)
);
CREATE INDEX IF NOT EXISTS idx_media_bands_lookup ON media_bands (tenant_id, kind, band_key);

CREATE TABLE IF NOT EXISTS reviewer_item_edges (
  tenant_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  risk DOUBLE PRECISION NOT NULL DEFAULT 0,
  signals TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (tenant_id, review_id)
);
CREATE INDEX IF NOT EXISTS idx_edges_tenant_time ON reviewer_item_edges (tenant_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_edges_item ON reviewer_item_edges (tenant_id, item_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  density DOUBLE PRECISION NOT NULL,
  member_count INTEGER NOT NULL,
  reviewer_ids TEXT NOT NULL,
  item_ids TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'candidate',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns (tenant_id, score DESC);

CREATE TABLE IF NOT EXISTS campaign_members (
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, campaign_id, reviewer_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_members_reviewer ON campaign_members (tenant_id, reviewer_id);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  label TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  notes TEXT,
  actor_hmac TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_review ON feedback (tenant_id, review_id);

CREATE TABLE IF NOT EXISTS appeals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reason TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolver_hmac TEXT,
  sla_due_at TEXT,
  handler_hmac TEXT,
  outcome_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals (tenant_id, status);

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  type TEXT NOT NULL,
  claim TEXT NOT NULL,
  substantiated BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'received',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notices_tenant ON notices (tenant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_notices_review ON notices (tenant_id, review_id);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TEXT NOT NULL,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs (status, run_after, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_tenant ON jobs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  seq BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log (tenant_id, seq);

CREATE TABLE IF NOT EXISTS usage_counters (
  tenant_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  period TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, metric, period)
);

CREATE TABLE IF NOT EXISTS risk_snapshots (
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  band TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  version TEXT NOT NULL,
  PRIMARY KEY (tenant_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS model_versions (
  version TEXT PRIMARY KEY,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_versions (
  tenant_id TEXT NOT NULL,
  version TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, version)
);
`;
