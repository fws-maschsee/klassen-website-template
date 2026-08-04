-- migrate:up
-- Absenderrecht als ausdrueckliche Richtlinie statt als Nebenwirkung leerer
-- Listen.
--
-- Entscheidung des Betreibers: Verteiler sollen grundsaetzlich von allen
-- benutzt werden koennen; wo das nicht gewollt ist, soll sich auch eine ganze
-- Domain freischalten lassen (`*@schule.example`).
--
-- Bisher ergab sich "wer darf senden" ausschliesslich aus `poster_groups`,
-- `extra_senders` und `broadcast`. Eine Liste ohne all das liess NIEMANDEN
-- senden — die restriktivste Einstellung war zugleich die, die man beim
-- Anlegen versehentlich bekommt. Das dreht `poster_policy` um und macht die
-- Absicht sichtbar:
--
--   'offen'           jede Absenderadresse darf schreiben. VORGABE fuer NEUE
--                     Listen (DEFAULT der Spalte).
--   'eingeschraenkt'  nur wer ueber `poster_groups` ODER `sender_patterns`
--                     erlaubt ist (`broadcast` gilt darin unveraendert
--                     weiter).
--
-- BESTAND BLEIBT WIE ER IST: Das UPDATE unten setzt alle vorhandenen Listen
-- ausdruecklich auf 'eingeschraenkt'. Die beiden laufenden Klassen aendern
-- durch diese Migration ihr Verhalten also NICHT — offen wird nur, was jemand
-- danach bewusst umstellt. Ein Verteiler, der ploetzlich Post aus dem ganzen
-- Internet annimmt, ist nichts, was aus einer Migration herausfallen darf.
ALTER TABLE mailing_lists
  ADD COLUMN poster_policy TEXT NOT NULL DEFAULT 'offen'
  CHECK (poster_policy IN ('offen', 'eingeschraenkt'));

UPDATE mailing_lists SET poster_policy = 'eingeschraenkt';

-- `extra_senders` hiess so, als dort nur volle Adressen stehen konnten. Jetzt
-- sind auch Domain-Platzhalter erlaubt, deshalb der ehrlichere Name. Der
-- Inhalt wandert unveraendert mit — RENAME COLUMN laesst die Werte in Ruhe.
--
--   volle Adresse       anna@example.org
--   Domain-Platzhalter  *@schule.example
--
-- Der Stern steht NUR ganz vorne und NUR fuer den lokalen Teil. Verglichen
-- wird case-insensitiv gegen die ENVELOPE-Adresse (siehe
-- src/lib/lists/incoming.ts) und die Domain exakt: `*@example.org` trifft
-- `anna@example.org`, aber NICHT `anna@mail.example.org`. Keine
-- Subdomain-Magie — die ueberrascht sonst genau dann, wenn es darauf ankommt.
ALTER TABLE mailing_lists RENAME COLUMN extra_senders TO sender_patterns;

-- migrate:down
-- forward-only, absichtlich leer
