-- migrate:up
CREATE TABLE mitglieder (
  id         TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  salutation TEXT NOT NULL CHECK (salutation IN ('Herr', 'Frau', 'Divers')),
  email      TEXT,
  phone      TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_mitglieder_email ON mitglieder (email);

CREATE TRIGGER trg_mitglieder_updated_at
AFTER UPDATE ON mitglieder
FOR EACH ROW
BEGIN
  UPDATE mitglieder SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- migrate:down
