-- migrate:up
CREATE TABLE email_send_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email_slug    TEXT NOT NULL REFERENCES emails (slug) ON DELETE CASCADE,
  mitglied_id   TEXT NOT NULL REFERENCES mitglieder (id) ON DELETE CASCADE,
  sent_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status        TEXT NOT NULL CHECK (status IN ('sent', 'error', 'skipped', 'queued', 'sending')),
  message_id    TEXT,
  error_message TEXT,
  claimed_at    TEXT
);

CREATE INDEX idx_send_log_slug_mitglied ON email_send_log (email_slug, mitglied_id);
CREATE INDEX idx_send_log_status        ON email_send_log (status);

-- migrate:down
