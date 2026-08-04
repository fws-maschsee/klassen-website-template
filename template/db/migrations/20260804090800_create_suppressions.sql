-- migrate:up
-- Zwei Suppression-Tabellen. Beide bedeuten "diese Person/Adresse bekommt
-- KEINE Mail (mehr)", aber sie beantworten unterschiedliche Fragen und haben
-- unterschiedliche Schluessel.
--
-- `list_suppressions` — Opt-out einer PERSON aus dem Adressbuch.
--   Getrennt von der Group-Mitgliedschaft, weil jemand in der Gruppe bleiben
--   soll (Klassenliste, Telefonkette), aber eben keine Listen-Mail will.
--   Mitgliedschaft != Mail-Praeferenz. `list_address = '*'` ist die Wildcard
--   ("will gar keine Verteiler-Mails"), damit EINE Tabelle pro-Liste UND
--   global abdeckt. Kein FK auf `mailing_lists`, weil '*' keine echte Liste
--   ist.
--
-- `address_suppressions` — Sperre einer ADRESSE, unabhaengig davon, ob dazu
--   eine Person im Adressbuch existiert. Das ist die Tabelle fuer die
--   Bounce-Behandlung: SES meldet einen Bounce/eine Beschwerde immer nur mit
--   einer E-Mail-Adresse, und diese Adresse kann auch aus `extra_recipients`
--   stammen, also gar kein `mitglied_id` haben. Ohne diese Tabelle sammelt
--   die Liste tote Adressen an, und SES stuft irgendwann die
--   Absenderreputation der Domain herab.
--
--   `source`: 'manual' (von Hand gesetzt), 'bounce' (harter Bounce),
--             'complaint' (Spam-Beschwerde). Fuer die Auswertung getrennt,
--             weil ein Complaint nie automatisch aufgehoben werden darf.
--   `bounce_type` / `bounce_subtype`: die Rohwerte aus der SES-Notification
--             ('Permanent'/'Transient'/'Undetermined' bzw.
--             'General'/'NoEmail'/'Suppressed'/...). Werden gespeichert,
--             damit spaeter entschieden werden kann, ob eine Sperre wirklich
--             dauerhaft sein muss.
--   `event_count` / `last_event_at`: mehrfach gemeldete Adressen erhoehen den
--             Zaehler, statt neue Zeilen anzulegen.
--
-- STAND DER AUTOMATIK: Die Tabelle und die Schreib-/Lesefunktionen sind
-- fertig, die automatische Befuellung aus SES-Bounce-Benachrichtigungen (SNS)
-- ist es NICHT — dafuer fehlen aktuell die IAM-Zugangsdaten. Bis dahin werden
-- Adressen ueber das MCP-Tool `suppress_list_recipient` von Hand gesperrt.
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
-- forward-only, absichtlich leer
