import type { Database } from 'better-sqlite3'
import { upsertGroup } from '../../lib/db/groups.js'
import { openDb } from '../../lib/db/index.js'
import { slugify, uniqueMemberId } from '../../lib/db/members.js'
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
 * Eintraege werden hier NIE angefasst; sie sind daran erkennbar, dass ihre
 * Spalte `zitadel_user_id` leer ist. Dazu kommt `extra_recipients` an der
 * Liste selbst fuer Adressen ganz ohne Adressbuch-Eintrag.
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

/**
 * ALTES Praefix der gespiegelten Eintraege. Frueher war die ZITADEL-Nummer der
 * Schluessel; heute steht sie in `zitadel_user_id`, und der Schluessel wird
 * wie ueberall sonst aus dem Namen abgeleitet. Das Praefix lebt nur noch, um
 * Zeilen aus der Zeit davor zu ERKENNEN und beim naechsten Abgleich
 * umzuschluesseln — siehe `rekeyLegacyRow`.
 */
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
	/**
	 * Zeilen, deren Schluessel von `zitadel-<nummer>` auf `vorname-nachname`
	 * umgestellt wurde. Einmalig je Zeile; steht dauerhaft auf 0, sobald der
	 * Bestand durch ist.
	 */
	rekeyed: number
	/**
	 * Davon die, bei denen der abgeleitete Schluessel schon vergeben war und
	 * deshalb ein `-2`/`-3`-Suffix bekommen hat. Eine Zahl groesser 0 heisst:
	 * zwei Eintraege tragen denselben Namen. Das kann stimmen (Geschwister)
	 * oder eine Dublette sein — ansehen lohnt sich.
	 */
	rekeyed_with_suffix: number
	/** Stand nach dem Abgleich. */
	total: number
}

/** Eine Adressbuch-Zeile, so wie die Spiegelung sie braucht. */
type MirroredRow = {
	id: string
	first_name: string
	last_name: string
	email: string | null
	zitadel_user_id: string
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

	// Gefunden wird ab jetzt ueber die ZITADEL-Nummer, nicht ueber einen aus
	// ihr zusammengebauten Schluessel. Damit darf die id heissen, wie sie
	// soll — und ein spaeteres Umbenennen bricht den Abgleich nicht.
	const existing = db
		.prepare<[], MirroredRow>(
			`SELECT id, first_name, last_name, email, zitadel_user_id
         FROM mitglieder
        WHERE zitadel_user_id IS NOT NULL`,
		)
		.all()
	const byUserId = new Map(existing.map((row) => [row.zitadel_user_id, row]))

	let added = 0
	let updated = 0
	let rekeyed = 0
	let rekeyedWithSuffix = 0
	const seen = new Set<string>()

	const insert = db.prepare(
		`INSERT INTO mitglieder (id, first_name, last_name, email, zitadel_user_id)
     VALUES (@id, @first_name, @last_name, @email, @zitadel_user_id)`,
	)
	const update = db.prepare(
		'UPDATE mitglieder SET first_name = @first_name, last_name = @last_name, email = @email WHERE id = @id',
	)
	const link = db.prepare<[string, string]>(
		'INSERT OR IGNORE INTO group_memberships (group_key, mitglied_id) VALUES (?, ?)',
	)
	const drop = db.prepare<[string]>('DELETE FROM mitglieder WHERE id = ?')

	/**
	 * Schreibt eine Zeile aus der Zeit vor `zitadel_user_id` auf einen aus dem
	 * Namen abgeleiteten Schluessel um und nimmt alle Verweise mit.
	 *
	 * Bewusst als "neu anlegen, Verweise umhaengen, alt loeschen" statt als
	 * `UPDATE mitglieder SET id = ...`: die Fremdschluessel zeigen mit
	 * ON DELETE CASCADE hierher, aber OHNE ON UPDATE. Ein Umschreiben der id
	 * bei eingeschalteten Fremdschluesseln liesse die Verweise ins Leere
	 * zeigen. So dagegen existiert die neue Zeile, BEVOR irgendein Verweis auf
	 * sie zeigt, und die alte faellt erst, wenn keiner mehr an ihr haengt —
	 * das Loeschen kann dann nichts mehr mitreissen. `list_outbound` hat gar
	 * keinen Fremdschluessel und muss ohnehin von Hand mit.
	 */
	const rekeyLegacyRow = (row: MirroredRow, first: string, last: string) => {
		const neu = uniqueMemberId(first, last, db, row.id)
		if (neu === row.id) return row.id
		insert.run({
			id: neu,
			first_name: first,
			last_name: last,
			email: row.email,
			zitadel_user_id: null,
		})
		for (const sql of [
			'UPDATE group_memberships SET mitglied_id = ? WHERE mitglied_id = ?',
			'UPDATE email_send_log SET mitglied_id = ? WHERE mitglied_id = ?',
			'UPDATE list_suppressions SET mitglied_id = ? WHERE mitglied_id = ?',
			'UPDATE list_outbound SET mitglied_id = ? WHERE mitglied_id = ?',
		]) {
			db.prepare<[string, string]>(sql).run(neu, row.id)
		}
		drop.run(row.id)
		db.prepare<[string, string]>(
			'UPDATE mitglieder SET zitadel_user_id = ? WHERE id = ?',
		).run(row.zitadel_user_id, neu)
		rekeyed++
		if (neu !== slugify(first, last)) rekeyedWithSuffix++
		return neu
	}

	const tx = db.transaction(() => {
		for (const user of granted) {
			seen.add(user.userId)
			const { first, last } = splitName(user)
			const current = byUserId.get(user.userId)
			if (!current) {
				const neu = uniqueMemberId(first, last, db)
				insert.run({
					id: neu,
					first_name: first,
					last_name: last,
					email: user.email,
					zitadel_user_id: user.userId,
				})
				added++
				link.run(groupKey, neu)
				continue
			}
			let id = current.id
			// Zeilen aus der Zeit davor tragen die Nummer noch im Schluessel.
			if (id.startsWith(MIRROR_ID_PREFIX)) {
				id = rekeyLegacyRow(current, first, last)
			}
			if (
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
		// oben hat nur Zeilen mit `zitadel_user_id` geholt.
		for (const [userId, row] of byUserId) {
			if (!seen.has(userId)) drop.run(row.id)
		}
	})
	tx()

	const removed = [...byUserId.keys()].filter((id) => !seen.has(id)).length
	return {
		added,
		updated,
		removed,
		rekeyed,
		rekeyed_with_suffix: rekeyedWithSuffix,
		total: granted.length,
	}
}
