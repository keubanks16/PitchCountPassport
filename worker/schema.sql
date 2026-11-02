-- Pitch Count Passport — D1 schema
-- Apply with:  npx wrangler d1 execute pitchcountpassport --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,          -- stored lowercased
  name          TEXT NOT NULL,
  pw_hash       TEXT NOT NULL,                 -- PBKDF2-SHA256 hex
  pw_salt       TEXT NOT NULL,                 -- 16 random bytes, hex
  pw_iter       INTEGER NOT NULL DEFAULT 210000,
  fails         INTEGER NOT NULL DEFAULT 0,    -- consecutive failed logins
  lock_until    INTEGER NOT NULL DEFAULT 0,    -- epoch ms
  created_at    INTEGER NOT NULL
);

-- Session tokens are random 256-bit values; only the SHA-256 of the token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  ua            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  birth_year    INTEGER NOT NULL,
  birth_month   INTEGER NOT NULL,              -- 1-12
  throws        TEXT NOT NULL DEFAULT 'R',     -- R or L
  share_code    TEXT NOT NULL UNIQUE,          -- 8 chars, given to coaches to link
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS players_owner ON players(owner_id);

-- Who may see / log for a player besides the owner. role: coach | viewer
CREATE TABLE IF NOT EXISTS player_access (
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  team_name     TEXT NOT NULL DEFAULT '',      -- the team this coach logs for
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (player_id, user_id)
);
CREATE INDEX IF NOT EXISTS access_user ON player_access(user_id);

-- One row per appearance. Dates are local calendar dates (YYYY-MM-DD) chosen by the logger.
CREATE TABLE IF NOT EXISTS outings (
  id            TEXT PRIMARY KEY,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  logged_by     TEXT NOT NULL REFERENCES users(id),
  date          TEXT NOT NULL,
  team_name     TEXT NOT NULL DEFAULT '',
  pitches       INTEGER NOT NULL,
  innings       REAL NOT NULL DEFAULT 0,
  caught        INTEGER NOT NULL DEFAULT 0,    -- 1 if the player also caught that day
  note          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outings_player_date ON outings(player_id, date);

-- Per-IP throttle buckets for signup / login.
CREATE TABLE IF NOT EXISTS throttle (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  reset_at      INTEGER NOT NULL
);
