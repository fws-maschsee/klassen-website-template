-- migrate:up
-- Eingegangene, akzeptierte Listen-Mails und ihr Versand-Fan-out. Bewusst
-- getrennt vom Rundmail-Pfad (`email_send_log`), weil hier KEIN Template
-- gerendert wird: die Originalmail wird 1:1 (Betreff, Body, Anhaenge)
-- weiterverteilt.
--
--   `list_messages`    -> eine Zeile je eingegangener Mail (geparste Teile)
--   `list_attachments` -> Anhaenge als BLOB (kleine Klassen-Volumina)
--   `list_outbound`    -> Fan-out: eine Zeile je Empfaenger, wird vom
--                         Queue-Worker ueber SES abgearbeitet. Gleiche
--                         Status-Semantik wie email_send_log
--                         (queued/sending/sent/error) inkl. `claimed_at` fuer
--                         den Stuck-Cleanup.
--
-- `idempotency_key` auf `list_messages` ist die Idempotenz des EINGANGS: der
-- Cloudflare-Worker kann dieselbe Mail bei einem Retry mehrfach abliefern
-- (SMTP-Zustellung ist at-least-once). Der Key ist die Message-ID der
-- Originalmail kombiniert mit der Listenadresse; ein UNIQUE-Index sorgt
-- dafuer, dass ein zweiter Anlauf keine zweite Verteilung ausloest, sondern
-- die vorhandene message_id zurueckliefert.
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

-- Partieller UNIQUE-Index: Mails ohne Message-ID (idempotency_key IS NULL)
-- bekommen keine Idempotenz-Garantie, blockieren sich aber auch nicht
-- gegenseitig.
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
-- forward-only, absichtlich leer
