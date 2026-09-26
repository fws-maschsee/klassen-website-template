-- migrate:up
CREATE TABLE mailing_lists (
  address          TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  recipient_groups TEXT NOT NULL DEFAULT '[]',
  poster_groups    TEXT NOT NULL DEFAULT '[]',
  extra_senders    TEXT NOT NULL DEFAULT '[]',
  extra_recipients TEXT NOT NULL DEFAULT '[]',
  reply_mode       TEXT NOT NULL DEFAULT 'sender' CHECK (reply_mode IN ('sender', 'list')),
  subject_prefix   TEXT,
  broadcast        INTEGER NOT NULL DEFAULT 0 CHECK (broadcast IN (0, 1)),
  aktiv            INTEGER NOT NULL DEFAULT 1 CHECK (aktiv IN (0, 1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER trg_mailing_lists_updated_at
AFTER UPDATE ON mailing_lists
FOR EACH ROW
BEGIN
  UPDATE mailing_lists SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE address = NEW.address;
END;

-- migrate:down
