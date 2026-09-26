-- migrate:up
CREATE TABLE emails (
  slug            TEXT PRIMARY KEY,
  subject         TEXT NOT NULL,
  sender          TEXT,
  recipients_kind TEXT NOT NULL,
  last_synced_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- migrate:down
