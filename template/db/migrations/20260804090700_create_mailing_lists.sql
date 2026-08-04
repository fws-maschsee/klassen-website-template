-- migrate:up
-- `mailing_lists` = Mailman-Ersatz. Jede Zeile ist EINE Verteiler-Adresse
-- (`address` ist nur der localpart vor dem @, z.B. 'eltern'; die Domain kommt
-- aus der Env-Variable LIST_DOMAIN). Eine eingehende Mail an
-- <address>@<LIST_DOMAIN> wird 1:1 an die Empfaenger weiterverteilt — aber nur,
-- wenn der Absender posten darf.
--
-- Alles setzt auf den bestehenden Gruppen auf ("alles ist eine Group"):
--   recipient_groups  JSON-Array von Group-Keys: wer bekommt die Mail. Wird
--                     EFFEKTIV aufgeloest (inkl. aller Untergruppen).
--   poster_groups     JSON-Array von Group-Keys: wer darf schreiben.
--   extra_recipients  JSON-Array zusaetzlicher Einzeladressen (Personen ohne
--                     Eintrag im Adressbuch, z.B. das Schulbuero).
--   extra_senders     JSON-Array zusaetzlicher erlaubter Absenderadressen.
-- Gruppen- und Einzeladressen werden bei der Aufloesung ueber die
-- E-Mail-Adresse (lowercase) dedupliziert.
--
-- Die Group-Keys werden bewusst NICHT per FK erzwungen (konsistent mit dem
-- restlichen Code, der Group-Existenz in der App-Schicht prueft): so blockiert
-- eine Liste nicht das Loeschen einer Gruppe, und `upsertMailingList`
-- validiert die Referenzen mit einer verstaendlichen Fehlermeldung.
--
-- reply_mode:
--   'sender' -> Reply-To zeigt auf den Originalabsender (Ankuendigungsliste)
--   'list'   -> Reply-To zeigt auf die Listenadresse (Diskussionsliste)
-- broadcast:
--   0 -> nur poster_groups/extra_senders duerfen senden (Ankuendigung)
--   1 -> zusaetzlich duerfen ALLE Empfaenger senden (offene Diskussion)
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
-- forward-only, absichtlich leer
