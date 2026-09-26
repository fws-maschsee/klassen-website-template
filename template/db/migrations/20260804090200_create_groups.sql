-- migrate:up
CREATE TABLE groups (
  key        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  aktiv      INTEGER NOT NULL DEFAULT 1 CHECK (aktiv IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER trg_groups_updated_at
AFTER UPDATE ON groups
FOR EACH ROW
BEGIN
  UPDATE groups SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = NEW.key;
END;

INSERT OR IGNORE INTO groups (key, label) VALUES ('eltern', 'Eltern');

-- migrate:down
