-- migrate:up
-- Wer darf an eine Mailingliste schreiben?
--
-- Bisher galt implizit: nur wer ueber `poster_groups` oder eine ausdrueckliche
-- Einzeladresse erlaubt war. Fuer die Verteiler einer Klassenelternschaft ist
-- das die falsche Vorgabe. Eine Liste `eltern` soll normalerweise von jedem
-- erreichbar sein — vom Schulbuero, von der Musiklehrerin, vom Elternteil, das
-- gerade von der Arbeitsadresse schreibt. Wer dort nicht durchkommt, merkt es
-- nicht: Die Mail landet als Unzustellbarkeitsnachricht bei ihm und nie bei
-- der Klasse.
--
--   poster_policy = 'offen'            jede Absenderadresse darf schreiben.
--                                      VORGABE fuer neue Listen.
--   poster_policy = 'eingeschraenkt'   nur wer ueber `poster_groups` ODER
--                                      `sender_patterns` erlaubt ist.
--
-- `broadcast` bleibt daneben bestehen und wirkt nur bei 'eingeschraenkt': es
-- nimmt zusaetzlich alle EMPFAENGER in den Kreis der Berechtigten auf (offene
-- Diskussionsliste unter Bekannten). Bei 'offen' ist es gegenstandslos.
ALTER TABLE mailing_lists ADD COLUMN poster_policy TEXT NOT NULL DEFAULT 'offen'
  CHECK (poster_policy IN ('offen', 'eingeschraenkt'));

-- `extra_senders` -> `sender_patterns`. Der neue Name sagt, was drinsteht:
-- nicht nur volle Adressen, sondern auch Domain-Platzhalter.
--
--   anna@example.org             genau diese Adresse
--   *@waldorfschule-beispiel.de  jede Adresse dieser Domain
--
-- Der Platzhalter steht nur ganz vorne und ersetzt nur den lokalen Teil.
-- `*@domain.tld` trifft also NICHT `user@sub.domain.tld` — sonst waere die
-- Freigabe einer Schuldomain zugleich die Freigabe jeder Subdomain, die
-- irgendwer darunter anlegt.
--
-- Verglichen wird case-insensitiv gegen den ENVELOPE-Absender (SMTP
-- `MAIL FROM`), nicht gegen den `From:`-Header: nur der Envelope laeuft gegen
-- SPF, der Header ist freier Text.
ALTER TABLE mailing_lists RENAME COLUMN extra_senders TO sender_patterns;

-- migrate:down
-- forward-only, absichtlich leer
