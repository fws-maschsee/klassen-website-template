-- migrate:up
-- `email_send_log` = Versand-Journal der Rundmails UND gleichzeitig die
-- Warteschlange. Eine Zeile je (Mail, Empfaenger, Versuch).
--
-- IDEMPOTENZ — der eigentliche Zweck dieser Tabelle:
-- Pro `email_slug` und `mitglied_id` darf es hoechstens EINEN erfolgreichen
-- Versand geben. Vor dem Einreihen wird geprueft, ob bereits eine Zeile mit
-- status='sent' existiert; wenn ja, wird der Empfaenger uebersprungen (bzw.
-- als 'skipped' protokolliert). Nur ein explizites `force` umgeht das. Eine
-- Korrektur verschickt man daher unter einem NEUEN Slug (Konvention: Suffix
-- `-v2`), nicht durch erneutes Senden desselben Slugs.
--
-- Status-Lebenslauf:
--   queued  -> vom Enqueue geschrieben, wartet auf den Worker
--   sending -> vom Worker atomar geclaimt (UPDATE ... WHERE status='queued')
--   sent    -> erfolgreich uebergeben, `message_id` gesetzt
--   error   -> Fehler beim Versand, `error_message` gesetzt
--   skipped -> bewusst nicht versendet (bereits versendet, keine Adresse,
--              Suppression)
--
-- `claimed_at` haelt fest, wann `queued -> sending` passiert ist. Der Worker
-- braucht das, um haengengebliebene Eintraege (SMTP-Stall, Pod-Restart) nach
-- einem Timeout wieder auf `error` zu kippen — sonst blieben sie fuer immer
-- in `sending` und niemand wuerde sie je abschliessen.
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
-- forward-only, absichtlich leer
