-- A shop can publish one or more machine-readable calendars. The Worker checks
-- them on a cron, imports new events as pending, and records what happened.
CREATE TABLE IF NOT EXISTS event_feeds (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'auto' CHECK (format IN ('auto', 'ics', 'jsonld')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  check_interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK (check_interval_minutes BETWEEN 15 AND 10080),
  etag TEXT,
  last_modified TEXT,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_event_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (store_id, url)
);

CREATE INDEX IF NOT EXISTS event_feeds_due_idx ON event_feeds(enabled, last_checked_at);
CREATE INDEX IF NOT EXISTS event_feeds_store_idx ON event_feeds(store_id);

-- Imported rows keep the registry entry and upstream identity that produced
-- them. Deleting a feed does not delete its events.
ALTER TABLE events ADD COLUMN feed_id TEXT REFERENCES event_feeds(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN source_uid TEXT;
ALTER TABLE events ADD COLUMN last_seen_at TEXT;
CREATE INDEX IF NOT EXISTS events_feed_idx ON events(feed_id);
CREATE UNIQUE INDEX IF NOT EXISTS events_store_source_uid_idx
  ON events(store_id, source_uid)
  WHERE source_uid IS NOT NULL;
