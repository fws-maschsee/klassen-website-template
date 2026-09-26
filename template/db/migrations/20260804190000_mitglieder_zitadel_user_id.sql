-- migrate:up
ALTER TABLE mitglieder ADD COLUMN zitadel_user_id TEXT;

-- UNIQUE als Index, weil ADD COLUMN kein UNIQUE erlaubt; mehrere NULL (Personen ohne Konto) bleiben möglich.
CREATE UNIQUE INDEX idx_mitglieder_zitadel_user_id
  ON mitglieder (zitadel_user_id);

-- Die ids selbst schlüsselt die Spiegelung um: nur slugify in TypeScript bildet die id-Regel exakt nach.
UPDATE mitglieder
   SET zitadel_user_id = substr(id, length('zitadel-') + 1)
 WHERE id LIKE 'zitadel-%';

-- migrate:down
