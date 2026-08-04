import type { MitgliedRow } from '../db/types.js'

/**
 * Persoenliche Ansprache fuer einen Adressbuch-Eintrag: "Hallo Anna,".
 *
 * Frueher stand hier eine nach Geschlecht unterschiedene Anrede ("Sehr
 * geehrte Frau ...", "Lieber ..."). Dafuer brauchte es die Spalte
 * `salutation` im Adressbuch, und die ist bewusst entfallen: gespeichert wird
 * nur noch, was fuer den Versand wirklich noetig ist (Name, E-Mail). Der
 * Vorname reicht fuer eine freundliche Ansprache und kommt ohne Angabe zum
 * Geschlecht aus.
 *
 * Render-Token: `{{anrede}}`.
 */
export const personalizedAnrede = (mitglied: MitgliedRow): string =>
	`Hallo ${mitglied.first_name},`
