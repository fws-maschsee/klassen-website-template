import type { Database } from 'better-sqlite3'
import { upsertGroup } from '../../lib/db/groups.js'
import { openDb } from '../../lib/db/index.js'
import type { MitgliedRow } from '../../lib/db/types.js'
import { clearGrantsCache, type GrantedUser, usersWithRole } from './grants.js'
import { ROLE_MITGLIED } from './roles.js'

/**
 * Die Empfaenger einer Klassenliste kommen aus ZITADEL.
 *
 * Warum ueberhaupt: Vorher gab es zwei getrennte Bestaende derselben
 * Menschen — die Grants in ZITADEL und die Tabelle `mitglieder`. Beide
 * muessten von Hand synchron gehalten werden, und das laeuft garantiert
 * auseinander. Es ist hier schon passiert: die abgeloeste PocketBase-Gruppe
 * enthielt 15 veraltete Eintraege, und 76 von 101 Eltern fehlten ganz.
 * Niemandem war es aufgefallen, weil es keinen Abgleich gab.
 *
 * Jetzt gilt: **wer den Grant hat, ist Empfaenger** — ohne zweiten Handgriff.
 * Familie kommt dazu, Grant, erreichbar. Familie geht, Grant weg, nicht mehr
 * erreichbar.
 *
 * Die Tabelle `mitglieder` bleibt trotzdem, denn sie hat einen eigenen Zweck:
 * nicht jeder, der Post bekommen soll, braucht einen Zugang — eine
 * Grossmutter, eine Lehrkraft ohne Konto, ein externer Kontakt. Solche
 * Eintraege werden hier NIE angefasst; sie sind daran erkennbar, dass ihre ID
 * nicht mit `zitadel-` beginnt. Dazu kommt `extra_recipients` an der Liste
 * selbst fuer Adressen ganz ohne Adressbuch-Eintrag.
 *
 * Warum gespiegelt und nicht bei jedem Versand direkt gefragt: Ein Versand,
 * der von der Verfuegbarkeit eines anderen Dienstes abhaengt, faellt mit ihm
 * aus — und eine Mail, die deshalb NICHT rausgeht, faellt niemandem auf.
 * Der Abgleich laeuft deshalb VOR der Verteilung und schreibt in die
 * Datenbank; scheitert er, verteilt die App mit dem letzten bekannten Stand
 * weiter und protokolliert den Fehler. Die Abweichung ist damit auf die Zeit
 * seit dem letzten geglueckten Abgleich begrenzt statt unbegrenzt — und der
 * Versand bleibt robust.
 *
 * DATENSCHUTZ: Was hier gespiegelt wird, sind Namen und E-Mail-Adressen. Sie
 * landen in der SQLite-Datei auf dem Volume des Pods — dort gehoeren sie hin.
 * Nicht in Git, nicht in Fixtures, nicht in Logs.
 */

/** Praefix der gespiegelten Eintraege. Alles andere ist von Hand gepflegt. */
export const MIRROR_ID_PREFIX = 'zitadel-'

/** Group, in die gespiegelte Personen wandern. */
export const memberGroupKey = (): string =>
	process.env.LIST_MEMBER_GROUP?.trim() || 'eltern'

/** Rolle, deren Grant jemanden zum Empfaenger macht. */
export const memberRole = (): string =>
	process.env.OIDC_REQUIRED_ROLE?.trim() || ROLE_MITGLIED

export type MirrorResult = {
	/** Neu hinzugekommene Personen. */
	added: number
	/** Aktualisierte Personen (Name oder Adresse geaendert). */
	updated: number
	/** Entfernte Personen — Grant weg. */
	removed: number
	/** Stand nach dem Abgleich. */
	total: number
}

const splitName = (user: GrantedUser): { first: string; last: string } => {
	if (user.firstName || user.lastName) {
		return { first: user.firstName, last: user.lastName }
	}
	// Ohne Profilnamen bleibt der lokale Teil der Adresse — besser als ein
	// leerer Name in der Anrede.
	const local = user.email.split('@')[0]
	return { first: local, last: '' }
}

/**
 * Gleicht die gespiegelten Eintraege gegen die aktuellen Grants ab.
 *
 * Faellt ZITADEL aus, wirft diese Funktion. Der Aufrufer entscheidet, ob das
 * den Vorgang abbricht (Verwaltung) oder nur protokolliert wird (Versand).
 */
export const syncMembersFromZitadel = async (
	db: Database = openDb(),
): Promise<MirrorResult> => {
	// Der Kurzzeit-Zwischenspeicher fuer Berechtigungspruefungen wird hier
	// bewusst verworfen: ein ausdruecklicher Abgleich will den frischesten
	// Stand, nicht einen fuenf Sekunden alten.
	clearGrantsCache()
	const granted = await usersWithRole(memberRole())
	const groupKey = memberGroupKey()

	// Die Zielgruppe muss existieren, sonst schlaegt die Zuordnung fehl. Sie
	// anzulegen ist idempotent und billiger als ein Startskript, das jemand
	// vergisst.
	upsertGroup({ key: groupKey, label: 'Eltern', aktiv: true }, db)

	const existing = db
		.prepare<[string], MitgliedRow>('SELECT * FROM mitglieder WHERE id LIKE ?')
		.all(`${MIRROR_ID_PREFIX}%`)
	const byId = new Map(existing.map((row) => [row.id, row]))

	let added = 0
	let updated = 0
	const seen = new Set<string>()

	const insert = db.prepare(
		`INSERT INTO mitglieder (id, first_name, last_name, email)
     VALUES (@id, @first_name, @last_name, @email)`,
	)
	const update = db.prepare(
		'UPDATE mitglieder SET first_name = @first_name, last_name = @last_name, email = @email WHERE id = @id',
	)
	const link = db.prepare<[string, string]>(
		'INSERT OR IGNORE INTO group_memberships (group_key, mitglied_id) VALUES (?, ?)',
	)
	const drop = db.prepare<[string]>('DELETE FROM mitglieder WHERE id = ?')

	const tx = db.transaction(() => {
		for (const user of granted) {
			const id = `${MIRROR_ID_PREFIX}${user.userId}`
			seen.add(id)
			const { first, last } = splitName(user)
			const current = byId.get(id)
			if (!current) {
				insert.run({
					id,
					first_name: first,
					last_name: last,
					email: user.email,
				})
				added++
			} else if (
				current.first_name !== first ||
				current.last_name !== last ||
				(current.email ?? '') !== user.email
			) {
				update.run({
					id,
					first_name: first,
					last_name: last,
					email: user.email,
				})
				updated++
			}
			link.run(groupKey, id)
		}

		// Wer keinen Grant mehr hat, verschwindet — genau das ist der Punkt der
		// Uebung. Von Hand angelegte Eintraege sind hier nicht dabei, die Abfrage
		// oben hat nur gespiegelte geholt.
		for (const id of byId.keys()) {
			if (!seen.has(id)) drop.run(id)
		}
	})
	tx()

	const removed = [...byId.keys()].filter((id) => !seen.has(id)).length
	return { added, updated, removed, total: granted.length }
}
