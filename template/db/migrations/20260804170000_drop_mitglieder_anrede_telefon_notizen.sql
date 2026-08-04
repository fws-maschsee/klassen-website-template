-- migrate:up transaction:false
-- Adressbuch auf das Noetige zurueckbauen: nur noch Name und E-Mail.
--
-- Entscheidung des Betreibers: Anrede, Telefonnummer und freie Notizen sind
-- zum jetzigen Zeitpunkt zu viel. Was nicht gespeichert wird, kann auch nicht
-- verloren gehen, falsch stehen oder in die falschen Haende geraten —
-- Datenminimierung ist hier keine Formalie, sondern die ganze Begruendung.
-- Fuer den Versand reichen Vorname, Nachname und Adresse.
--
-- ZU `salutation` IM BESONDEREN: Die Spalte war NOT NULL, und beim Import aus
-- der Klassenliste sowie beim Spiegeln aus ZITADEL gab es die Angabe schlicht
-- nicht. Eingetragen wurde deshalb 'Divers' als Notausgang — in beiden
-- laufenden Klassen bei der grossen Mehrheit der Eintraege. Das Feld hat also
-- kein Wissen gespeichert, sondern welches erfunden, und dieses erfundene
-- Wissen stand anschliessend in der Anrede jeder Rundmail.
--
-- ZU `notes`: Ein Freitextfeld sammelt genau das ein, wofuer es keine Spalte
-- gibt — hier waren es Kindernamen, Geburtsdaten und Wohnanschriften, die
-- dort niemand haben wollte. Deshalb faellt das Feld weg, statt es nur
-- "kuenftig nicht mehr zu befuellen": solange es da ist, laedt es dazu ein.
--
-- Die Anrede fiel damit auch fuer die persoenliche Ansprache in Rundmails
-- weg. `{{anrede}}` liefert seitdem "Hallo <Vorname>," — ohne
-- Geschlechtsangabe (siehe src/lib/email/anrede.ts und README).
--
-- WARUM EIN TABELLEN-NEUBAU und kein `ALTER TABLE ... DROP COLUMN`:
-- `salutation` haengt an einer CHECK-Bedingung; SQLite verweigert das
-- Loeschen einer Spalte, die in einem CHECK vorkommt. Also die 12 Schritte
-- aus der SQLite-Doku ("Making Other Kinds Of Table Schema Changes"):
-- neue Tabelle, Daten kopieren, alte loeschen, umbenennen, Index und Trigger
-- neu anlegen.
--
-- WARUM `transaction:false` UND `PRAGMA foreign_keys = OFF`:
-- `group_memberships`, `list_suppressions` und `email_send_log` zeigen mit
-- ON DELETE CASCADE auf `mitglieder`. Mit eingeschalteten Fremdschluesseln
-- wuerde das `DROP TABLE` unten alle Gruppenzuordnungen, Opt-outs und
-- Versandprotokolle mitreissen. Die Pragma-Anweisung wirkt nur AUSSERHALB
-- einer Transaktion — deshalb darf dbmate diese Migration nicht in eine
-- eigene Transaktion einpacken, und die noetige Klammer steht hier explizit.
-- Die verbleibenden REFERENCES-Klauseln zeigen weiterhin textuell auf
-- "mitglieder" und treffen nach dem Umbenennen wieder die richtige Tabelle.
PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE mitglieder_neu (
  id         TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  email      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO mitglieder_neu (id, first_name, last_name, email, created_at, updated_at)
  SELECT id, first_name, last_name, email, created_at, updated_at FROM mitglieder;

DROP TABLE mitglieder;

ALTER TABLE mitglieder_neu RENAME TO mitglieder;

CREATE INDEX idx_mitglieder_email ON mitglieder (email);

CREATE TRIGGER trg_mitglieder_updated_at
AFTER UPDATE ON mitglieder
FOR EACH ROW
BEGIN
  UPDATE mitglieder SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

COMMIT;

PRAGMA foreign_keys = ON;

-- migrate:down
-- forward-only, absichtlich leer
