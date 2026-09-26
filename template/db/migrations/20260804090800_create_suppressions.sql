-- migrate:up
CREATE TABLE list_suppressions (
  mitglied_id  TEXT NOT NULL REFERENCES mitglieder (id) ON DELETE CASCADE,
  list_address TEXT NOT NULL,
  reason       TEXT,
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'bounce', 'complaint')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (mitglied_id, list_address)
);

CREATE INDEX idx_list_suppressions_address ON list_suppressions (list_address);

CREATE TABLE address_suppressions (
  email          TEXT NOT NULL,
  list_address   TEXT NOT NULL,
  reason         TEXT,
  source         TEXT NOT NULL DEFAULT 'bounce' CHECK (source IN ('manual', 'bounce', 'complaint')),
  bounce_type    TEXT,
  bounce_subtype TEXT,
  event_count    INTEGER NOT NULL DEFAULT 1,
  last_event_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (email, list_address)
);

CREATE INDEX idx_address_suppressions_address ON address_suppressions (list_address);

-- migrate:down
