-- bookloop schema
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  city TEXT,
  bio TEXT,
  shelf_visibility TEXT NOT NULL DEFAULT 'friends' CHECK (shelf_visibility IN ('friends', 'private')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  kind TEXT NOT NULL,
  challenge TEXT NOT NULL,
  payload TEXT,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  osm_type TEXT,
  osm_id TEXT,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT,
  neighborhood TEXT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  website TEXT,
  phone TEXT,
  opening_hours TEXT,
  is_indie INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'osm',
  source_url TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS stores_city_idx ON stores(city);
CREATE INDEX IF NOT EXISTS stores_name_idx ON stores(name);

CREATE TABLE IF NOT EXISTS store_tags (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'osm',
  PRIMARY KEY (store_id, tag)
);

CREATE TABLE IF NOT EXISTS store_vibes (
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (store_id, user_id, tag)
);

CREATE INDEX IF NOT EXISTS store_vibes_store_idx ON store_vibes(store_id, tag);

CREATE TABLE IF NOT EXISTS favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, store_id)
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  store_id TEXT REFERENCES stores(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'Event',
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  url TEXT,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'submitted',
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'pending', 'rejected')),
  submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS events_start_idx ON events(status, starts_at);
CREATE INDEX IF NOT EXISTS events_store_idx ON events(store_id, starts_at);

CREATE TABLE IF NOT EXISTS rsvps (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  cover_url TEXT,
  subjects TEXT,
  first_publish_year INTEGER,
  checked_at TEXT
);

CREATE TABLE IF NOT EXISTS shelf (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('want', 'reading', 'read')),
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, book_id)
);

CREATE TABLE IF NOT EXISTS user_genres (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  genre TEXT NOT NULL,
  PRIMARY KEY (user_id, genre)
);

CREATE TABLE IF NOT EXISTS friends (
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);

CREATE TABLE IF NOT EXISTS store_claims (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  contact TEXT NOT NULL,
  role TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
