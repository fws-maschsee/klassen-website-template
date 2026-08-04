-- migrate:up
-- `emails` = Metadaten der Rundmails, deren Inhalt als TypeScript-Datei unter
-- `emails/<slug>.ts` im Repo liegt (Inhalt = Text, keine personenbezogenen
-- Daten). Die Zeile hier ist nur der Anker fuer den FK aus `email_send_log`
-- und ein Cache der wichtigsten Kopfdaten; Quelle der Wahrheit bleibt die
-- Datei.
CREATE TABLE emails (
  slug            TEXT PRIMARY KEY,
  subject         TEXT NOT NULL,
  sender          TEXT,
  recipients_kind TEXT NOT NULL,
  last_synced_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- migrate:down
-- forward-only, absichtlich leer
