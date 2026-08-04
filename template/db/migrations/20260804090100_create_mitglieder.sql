-- migrate:up
-- ACHTUNG, HISTORISCH: Die Spalten `salutation`, `phone` und `notes` sind mit
-- 20260804170000_drop_mitglieder_anrede_telefon_notizen wieder entfallen. Der
-- aktuelle Stand der Tabelle steht dort. Diese Datei bleibt unveraendert
-- ausser diesem Hinweis — Migrationen sind forward-only und werden nicht
-- nachtraeglich umgeschrieben.
--
-- `mitglieder` = das Adressbuch der Klasse: Eltern, Lehrkraefte, sonstige
-- Ansprechpartner. Der Tabellenname ist bewusst aus der Referenz-
-- implementierung (cdu-nordstemmen/vorstand) uebernommen, damit Schema,
-- Repositories und Tests zwischen beiden Projekten eins zu eins vergleichbar
-- bleiben. "Mitglied" heisst hier schlicht "Person im Adressbuch" — es gibt
-- keine Mitgliedschaft im Vereinssinn.
--
-- DATENSCHUTZ (harte Regel): Diese Tabelle enthaelt Namen und
-- E-Mail-Adressen von Eltern. Sie lebt AUSSCHLIESSLICH in der SQLite-Datei im
-- Pod. Keine Seed-Dateien, keine Fixtures, keine Migrationsskripte mit echten
-- Daten im Git-Repo. Auch Test-Fixtures benutzen ausschliesslich erfundene
-- Namen und `example.org`-Adressen.
--
-- Rollen und Zugehoerigkeiten stehen NICHT hier, sondern als Zeilen in
-- `group_memberships` ("alles ist eine Group"). Damit gibt es keinen
-- Boolean-Wildwuchs auf der Haupttabelle.
--
-- `id` ist stabil und wird beim Anlegen aus dem Namen abgeleitet
-- (`vorname-nachname`, siehe src/lib/db/members.ts), kann aber explizit
-- gesetzt werden. Bewusst KEIN UNIQUE-Index auf (first_name, last_name):
-- Namensgleichheit ist in einer Schulklasse (Geschwisterkinder, Eltern mit
-- gleichem Namen) moeglich; wer sie hat, vergibt eine explizite `id`.
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
-- forward-only, absichtlich leer
