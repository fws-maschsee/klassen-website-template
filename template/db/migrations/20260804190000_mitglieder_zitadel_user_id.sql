-- migrate:up
-- Die ZITADEL-Nutzernummer bekommt eine eigene Spalte, statt im Schluessel zu
-- stehen.
--
-- Bisher legte die Spiegelung (src/server/auth/mirror.ts) ihre Eintraege unter
-- `zitadel-<nummer>` an. Damit fuehrte das Adressbuch zwei Sorten Schluessel
-- nebeneinander — die einen aus dem Namen abgeleitet, wie
-- 20260804090100_create_mitglieder.sql es vorschreibt, die anderen die interne
-- Nutzernummer eines fremden Systems. Sie stand ausserdem sichtbar in der
-- Oberflaeche und in jeder MCP-Ausgabe.
--
-- Die Nummer selbst darf NICHT verschwinden: sie ist die einzige STABILE
-- Verbindung zur Anmeldung. Namen und E-Mail-Adressen aendern sich (Heirat,
-- neuer Anbieter), die Nummer nicht. Sie wandert deshalb hierher:
--
--   zitadel_user_id   NULL bei von Hand angelegten Personen (Grosseltern,
--                     Lehrkraefte, externe Kontakte — die haben keinen
--                     Zugang). Gesetzt bei allen gespiegelten.
--
-- UNIQUE als eigener Index statt als Spalten-Constraint: SQLite erlaubt in
-- `ALTER TABLE ... ADD COLUMN` kein UNIQUE. Der Index leistet dasselbe und
-- laesst mehrere NULL zu — genau richtig, denn "kein Zugang" ist der
-- Normalfall fuer die Haelfte der Eintraege.
ALTER TABLE mitglieder ADD COLUMN zitadel_user_id TEXT;

CREATE UNIQUE INDEX idx_mitglieder_zitadel_user_id
  ON mitglieder (zitadel_user_id);

-- Bestand: Die Nummer steckt bei den gespiegelten Zeilen im Schluessel. Hier
-- wird sie herausgezogen, ohne den Schluessel selbst anzufassen.
UPDATE mitglieder
   SET zitadel_user_id = substr(id, length('zitadel-') + 1)
 WHERE id LIKE 'zitadel-%';

-- WARUM DAS UMSCHLUESSELN NICHT HIER PASSIERT, sondern in TypeScript:
--
-- Die Regel fuer `id` steht in src/lib/db/members.ts (`slugify`) und benutzt
-- `String.normalize('NFD')`, um beliebige Diakritika abzutragen — nicht nur
-- die deutschen Umlaute, sondern auch é, ø, ł, ş und was sonst in Namen
-- vorkommt. SQLite kann das nicht nachbilden. Eine SQL-Fassung waere also
-- eine ZWEITE, leicht abweichende Regel, und genau das ist gefaehrlich: Wo
-- die beiden auseinanderlaufen, berechnet das naechste `upsertMitglied` eine
-- ANDERE id als die Migration vergeben hat und legt dieselbe Person ein
-- zweites Mal an. Ein Adressbuch mit stillen Dubletten ist schlimmer als eins
-- mit haesslichen Schluesseln.
--
-- Das Umschluesseln macht deshalb die Spiegelung selbst, mit genau der
-- Funktion, die auch sonst ids vergibt: sie sucht Personen ab jetzt ueber
-- `zitadel_user_id`, und wo die id noch das alte `zitadel-`-Praefix traegt,
-- schreibt sie sie auf `vorname-nachname` um und nimmt die Verweise aus
-- group_memberships, email_send_log, list_suppressions und list_outbound
-- mit — in EINER Transaktion, mit eingeschalteten Fremdschluesseln (neue
-- Zeile anlegen, Verweise umhaengen, alte Zeile loeschen). Der Schritt ist
-- idempotent: was einmal umgeschluesselt ist, bleibt es.
--
-- ACHTUNG NAMENSGLEICHHEIT: Die Ausgangsmigration weist ausdruecklich darauf
-- hin, dass es KEINEN UNIQUE-Index auf (first_name, last_name) gibt —
-- Geschwisterkinder und gleichnamige Eltern sind moeglich. Trifft ein
-- abgeleiteter Schluessel auf einen schon vergebenen, haengt die Spiegelung
-- deterministisch `-2`, `-3`, ... an. Das loest die Schluesselkollision,
-- NICHT die Frage, ob dahinter zweimal dieselbe Person steht; das muss ein
-- Mensch entscheiden.

-- migrate:down
-- forward-only, absichtlich leer
