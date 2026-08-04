import type { Database } from 'better-sqlite3'
import {
	getMitgliederByIds,
	listMitgliederByGroupEffective,
} from '../db/members.js'
import type { MitgliedRow } from '../db/types.js'
import type { Recipients } from './types.js'

/**
 * Loest die Empfaenger-Spec einer Rundmail zu konkreten Personen auf.
 *
 * Die Gruppen-Aufloesung ist EFFEKTIV
 * (`listMitgliederByGroupEffective`): eine Obergruppe erreicht automatisch die
 * Mitglieder ihrer (rekursiven) Untergruppen. Ohne Untergruppen verhaelt es
 * sich wie eine einfache Mitgliederabfrage.
 *
 * `explicit` liefert genau die angefragten IDs, unabhaengig von
 * Gruppenzugehoerigkeit. `union` bildet die Vereinigung mehrerer Specs,
 * rekursiv aufgeloest und ueber die Mitglieds-ID dedupliziert (die
 * Reihenfolge des ersten Vorkommens bleibt erhalten).
 */
export const resolveRecipients = (
	recipients: Recipients,
	db?: Database,
): MitgliedRow[] => {
	switch (recipients.kind) {
		case 'group':
			return listMitgliederByGroupEffective(recipients.value, db)
		case 'explicit':
			return getMitgliederByIds(recipients.ids, db)
		case 'union': {
			const seen = new Set<string>()
			const out: MitgliedRow[] = []
			for (const sub of recipients.of) {
				for (const m of resolveRecipients(sub, db)) {
					if (!seen.has(m.id)) {
						seen.add(m.id)
						out.push(m)
					}
				}
			}
			return out
		}
	}
}

/** Wer bekommt eine E-Mail? Jeder Eintrag mit hinterlegter Adresse. */
export const isEmailRecipient = (m: MitgliedRow): boolean => !!m.email

/**
 * Wer ist gar nicht per Mail erreichbar? Die UI/das MCP-Tool sollte solche
 * Eintraege sichtbar machen, damit eine fehlende Adresse nachgetragen werden
 * kann, statt dass sie still aus dem Verteiler fallen.
 */
export const isUnreachable = (m: MitgliedRow): boolean => !m.email
