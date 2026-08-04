-- migrate:up
-- `group_edges` = gerichtete Kanten ZWISCHEN Gruppen ("Gruppe X enthaelt
-- Gruppe Y"). Damit werden Ober-/Untergruppen (Supersets/Subsets) moeglich,
-- ohne einzelne Personen doppelt zu pflegen: Eine Obergruppe wie `eltern`
-- bekommt z.B. die Untergruppen der einzelnen Arbeitsgruppen; ihre EFFEKTIVE
-- Mitgliedschaft ist dann die Vereinigung aller (rekursiven)
-- Kind-Mitgliedschaften.
--
-- Modell-Entscheidungen (unveraendert aus der Referenzimplementierung
-- uebernommen):
--   - m:n: eine Gruppe kann mehrere Kinder haben UND selbst Kind mehrerer
--     Obergruppen sein -> gerichteter azyklischer Graph, kein reiner Baum.
--   - Mischbetrieb erlaubt: eine Gruppe darf gleichzeitig direkte Mitglieder
--     (group_memberships) UND Kindgruppen haben. Effektiv = Vereinigung.
--   - Zyklen werden in der App-Schicht beim Anlegen einer Kante abgelehnt
--     (ein Kind darf kein Vorfahre seines Parents sein, siehe
--     `wouldCreateCycle` in src/lib/db/groups.ts). Der rekursive CTE
--     terminiert dank `UNION` zusaetzlich auch bei Altlasten.
--
-- FK CASCADE: Wird eine Gruppe geloescht, verschwinden ihre Kanten (als
-- Parent wie als Kind). CHECK verbietet die triviale Selbst-Kante X->X.
CREATE TABLE group_edges (
  parent_key TEXT NOT NULL REFERENCES groups (key) ON DELETE CASCADE,
  child_key  TEXT NOT NULL REFERENCES groups (key) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (parent_key, child_key),
  CHECK (parent_key <> child_key)
);

-- Reverse-Lookup "wessen Kind ist diese Gruppe?" (Vorfahren-Aufloesung).
CREATE INDEX idx_group_edges_child ON group_edges (child_key);

-- migrate:down
-- forward-only, absichtlich leer
