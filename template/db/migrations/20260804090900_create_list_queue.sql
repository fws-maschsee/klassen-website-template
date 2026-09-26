-- migrate:up
CREATE TABLE list_messages (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  list_address        TEXT NOT NULL,
  from_email          TEXT NOT NULL,
  from_name           TEXT,
  subject             TEXT NOT NULL DEFAULT '',
  body_html           TEXT,
  body_text           TEXT,
  original_message_id TEXT,
  idempotency_key     TEXT,
  received_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_list_messages_idempotency
  ON list_messages (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE list_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id   INTEGER NOT NULL REFERENCES list_messages (id) ON DELETE CASCADE,
  filename     TEXT,
  content_type TEXT,
  content      BLOB NOT NULL
);

CREATE INDEX idx_list_attachments_message ON list_attachments (message_id);

CREATE TABLE list_outbound (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL REFERENCES list_messages (id) ON DELETE CASCADE,
  recipient_email TEXT NOT NULL,
  mitglied_id     TEXT,
  status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'error')),
  sent_message_id TEXT,
  error_message   TEXT,
  claimed_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  sent_at         TEXT
);

CREATE INDEX idx_list_outbound_status  ON list_outbound (status);
CREATE INDEX idx_list_outbound_message ON list_outbound (message_id);

-- migrate:down
