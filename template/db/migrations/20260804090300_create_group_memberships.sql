-- migrate:up
-- `group_memberships` = m:n zwischen `mitglieder` und `groups`. Eine Zeile
-- bedeutet "Person X ist DIREKT in Gruppe Y".
--
-- Wichtig fuer das Verstaendnis des ganzen Modells:
--   DIREKTE Mitgliedschaft  = genau diese Tabelle. Sie ist das, was
--                             geschrieben wird (add/remove/set).
--   EFFEKTIVE Mitgliedschaft = direkte Mitglieder PLUS rekursiv alle
--                             Mitglieder der Untergruppen (`group_edges`),
--                             dedupliziert. Wird beim Aufloesen berechnet,
--                             nie gespeichert, und gilt ueberall, wo eine
--                             Gruppe Personen liefert (E-Mail-Empfaenger,
--                             Mailinglisten, Zaehler, list_group_members).
--
-- FK CASCADE: Wird eine Person oder eine Gruppe geloescht, verschwinden ihre
-- Mitgliedschaften automatisch (setzt PRAGMA foreign_keys=ON voraus, siehe
-- src/lib/db/index.ts).
CREATE TABLE group_memberships (
  group_key   TEXT NOT NULL REFERENCES groups (key) ON DELETE CASCADE,
  mitglied_id TEXT NOT NULL REFERENCES mitglieder (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_key, mitglied_id)
);

CREATE INDEX idx_group_memberships_mitglied ON group_memberships (mitglied_id);

-- migrate:down
-- forward-only, absichtlich leer
