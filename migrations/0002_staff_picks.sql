-- Staff picks: a bookseller's hand-sell, attached to a shop and reviewed by a human.
CREATE TABLE IF NOT EXISTS staff_picks (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  author TEXT,
  note TEXT NOT NULL,
  bookseller TEXT,
  section TEXT,
  source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'editor')),
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected')),
  submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS staff_picks_store_idx ON staff_picks(store_id, status, created_at);
CREATE INDEX IF NOT EXISTS staff_picks_status_idx ON staff_picks(status, created_at);
