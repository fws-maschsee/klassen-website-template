-- migrate:up
-- Rollen an den MCP-Tokens.
--
-- Die Berechtigung einer Person steht in ZITADEL (Projektrollen `mitglied`
-- und `admin`), und die Weboberflaeche liest sie bei jeder Anfrage frisch aus
-- dem Sitzungs-Cookie. Ein MCP-Client hat dieses Cookie nicht — er kommt mit
-- einem Bearer-Token, das aus einem laengst vergangenen Anmeldevorgang
-- stammt. Damit `upsert_mitglied` ueber MCP dieselbe Pruefung durchlaeuft wie
-- ein Klick in der Oberflaeche, wandern die Rollen beim Zustimmen in den
-- Authorization Code und von dort in die Tokens.
--
-- Die Rollen sind damit so aktuell wie das Token: ein entzogener
-- `admin`-Grant wirkt spaetestens, wenn das Access-Token abgelaufen ist (1 h)
-- — dieselbe Groessenordnung wie die stuendliche Nachfrage der Weboberflaeche
-- beim IdP. Sofort wirksam wird ein Entzug ueber `revokeToken` bzw. das
-- Loeschen des Clients.
--
-- Bestandszeilen bekommen NULL. `rolesFromToken` liest das als leere Liste:
-- Tokens von vor dieser Migration duerfen lesen, aber nicht schreiben. Das
-- ist die sichere Richtung.

ALTER TABLE oauth_authorization_codes ADD COLUMN roles TEXT; -- JSON-Array
ALTER TABLE oauth_access_tokens       ADD COLUMN roles TEXT; -- JSON-Array
ALTER TABLE oauth_refresh_tokens      ADD COLUMN roles TEXT; -- JSON-Array

-- migrate:down
-- forward-only, absichtlich leer
