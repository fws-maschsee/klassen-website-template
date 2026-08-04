-- migrate:up
-- `groups` = Whitelist aller Gruppen/Verteiler. EIN Modell fuer alle
-- Zugehoerigkeiten ("alles ist eine Group"): Elternschaft der Klasse,
-- Elternvertretung, Arbeitsgruppen, Ad-hoc-Verteiler — alles nur Zeilen hier.
--
-- `group_memberships` verweist per FK auf `key`, dadurch sind ausschliesslich
-- existierende Group-Keys als Mitgliedschaft erlaubt (Whitelist-Enforcement
-- gegen Tippfehler).
CREATE TABLE groups (
  key        TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  aktiv      INTEGER NOT NULL DEFAULT 1 CHECK (aktiv IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TRIGGER trg_groups_updated_at
AFTER UPDATE ON groups
FOR EACH ROW
BEGIN
  UPDATE groups SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = NEW.key;
END;

-- Eine einzige System-Gruppe wird angelegt: `eltern`. Sie ist der Default-
-- Verteiler der Klasse und die Gruppe, auf die eine frisch aufgesetzte
-- Instanz ihre Mailingliste zeigen kann. Alle weiteren Gruppen (Elternvertretung,
-- Arbeitsgruppen, Untergruppen) werden ueber das MCP-Tool `upsert_group`
-- angelegt — sie werden hier bewusst NICHT geraten.
INSERT OR IGNORE INTO groups (key, label) VALUES ('eltern', 'Eltern');

-- migrate:down
-- forward-only, absichtlich leer
