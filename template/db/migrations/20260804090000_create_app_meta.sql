-- migrate:up
-- `app_meta` = Schluessel/Wert-Ablage fuer Dinge, die zur DATENBANK gehoeren
-- und nicht zur Deployment-Umgebung. Aktuell genau ein Eintrag:
--
--   instance -> Name der Klassen-Instanz, zu der diese Datei gehoert
--               (z.B. 'klasse-musterfrau' oder 'klasse-nachbar').
--
-- Hintergrund: Es gibt EIN Deployment PRO KLASSE mit jeweils eigener
-- SQLite-Datei. Wer versehentlich mit der falschen DB arbeitet, verschickt
-- Elternpost der einen Klasse an die Eltern der anderen. Die Env-Variable
-- `MCP_INSTANCE_NAME` allein schuetzt davor nicht: sie sagt nur, was das
-- Deployment zu sein GLAUBT, nicht was in der Datei steht. Deshalb wird der
-- Name beim ersten Start in die Datei geschrieben und danach bei jedem Start
-- gegen die Env geprueft (src/lib/db/instance.ts). Weicht beides voneinander
-- ab, faehrt der Server gar nicht erst hoch.
CREATE TABLE app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- migrate:down
-- forward-only, absichtlich leer
