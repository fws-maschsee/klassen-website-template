import type { Database } from 'better-sqlite3'
import { openDb } from './index.js'
import { normalizeEmail } from './mailingLists.js'
import type {
	AddressSuppressionRow,
	ListSuppressionRow,
	SuppressionSource,
} from './types.js'

/**
 * Suppressions — "wer bekommt KEINE Mail".
 *
 * Zwei Ebenen, weil zwei verschiedene Fragen beantwortet werden:
 *
 *   PERSON  (`list_suppressions`): "Frau X will keine Listenmails."
 *           Bleibt an der Person haengen, auch wenn sie ihre Adresse wechselt.
 *           Wird von Hand gepflegt (MCP-Tool).
 *
 *   ADRESSE (`address_suppressions`): "an diese Adresse darf nicht mehr
 *           zugestellt werden." Das ist die Ebene, auf der Bounces und
 *           Beschwerden ankommen — SES meldet nur eine Adresse, und die kann
 *           zu gar keinem Adressbuch-Eintrag gehoeren (`extra_recipients`).
 *           Ohne diese Ebene sammelt die Liste tote Adressen und SES stuft die
 *           Absenderreputation der Domain herab.
 *
 * `list_address = '*'` ist in beiden Tabellen die Wildcard "gilt fuer alle
 * Listen". Bounces werden immer global eingetragen: eine unzustellbare
 * Adresse ist auf jeder Liste unzustellbar.
 */

/** Wildcard-Adresse fuer den globalen Opt-out ("keine Verteiler-Mails"). */
export const GLOBAL_SUPPRESSION = '*'

const normalizeListAddress = (listAddress: string): string =>
	listAddress === GLOBAL_SUPPRESSION
		? GLOBAL_SUPPRESSION
		: normalizeEmail(listAddress)

// ---------------------------------------------------------------------------
// Personengebunden
// ---------------------------------------------------------------------------

/**
 * Traegt einen Opt-out fuer eine Person ein (idempotent). Die Person bleibt in
 * ihrer Gruppe (Klassenliste, Telefonkette), bekommt aber keine Mail dieser
 * Liste mehr.
 */
export const suppressListRecipient = (
	mitgliedId: string,
	listAddress: string,
	reason: string | null = null,
	source: SuppressionSource = 'manual',
	db: Database = openDb(),
): ListSuppressionRow[] => {
	const exists = db
		.prepare<[string], { id: string }>('SELECT id FROM mitglieder WHERE id = ?')
		.get(mitgliedId)
	if (!exists)
		throw new Error(`Kein Eintrag im Adressbuch mit id="${mitgliedId}".`)

	db.prepare<[string, string, string | null, string]>(
		`INSERT INTO list_suppressions (mitglied_id, list_address, reason, source)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(mitglied_id, list_address) DO UPDATE SET
       reason = excluded.reason,
       source = excluded.source`,
	).run(mitgliedId, normalizeListAddress(listAddress), reason, source)

	return listSuppressionsForMitglied(mitgliedId, db)
}

/** Entfernt einen personengebundenen Opt-out wieder. */
export const unsuppressListRecipient = (
	mitgliedId: string,
	listAddress: string,
	db: Database = openDb(),
): ListSuppressionRow[] => {
	db.prepare<[string, string]>(
		'DELETE FROM list_suppressions WHERE mitglied_id = ? AND list_address = ?',
	).run(mitgliedId, normalizeListAddress(listAddress))
	return listSuppressionsForMitglied(mitgliedId, db)
}

export const listSuppressionsForMitglied = (
	mitgliedId: string,
	db: Database = openDb(),
): ListSuppressionRow[] =>
	db
		.prepare<[string], ListSuppressionRow>(
			'SELECT * FROM list_suppressions WHERE mitglied_id = ? ORDER BY list_address',
		)
		.all(mitgliedId)

/** Alle personengebundenen Opt-outs einer Liste. */
export const listSuppressionsForAddress = (
	listAddress: string,
	db: Database = openDb(),
): ListSuppressionRow[] =>
	db
		.prepare<[string], ListSuppressionRow>(
			'SELECT * FROM list_suppressions WHERE list_address = ? ORDER BY mitglied_id',
		)
		.all(normalizeListAddress(listAddress))

// ---------------------------------------------------------------------------
// Adressgebunden (Bounces, Beschwerden, Adressen ohne Adressbuch-Eintrag)
// ---------------------------------------------------------------------------

export type SuppressAddressInput = {
	email: string
	/** Listen-localpart oder `*` (Default) fuer "alle Listen". */
	list_address?: string
	source?: SuppressionSource
	reason?: string | null
	/** SES-Rohwert `Permanent` | `Transient` | `Undetermined`. */
	bounce_type?: string | null
	/** SES-Rohwert `General` | `NoEmail` | `Suppressed` | ... */
	bounce_subtype?: string | null
}

/**
 * Sperrt eine E-Mail-Adresse (idempotent). Bei wiederholter Meldung derselben
 * Adresse wird `event_count` hochgezaehlt und `last_event_at` aktualisiert,
 * statt eine zweite Zeile anzulegen — so bleibt sichtbar, wie oft eine Adresse
 * bereits geprellt hat.
 *
 * Das ist die Funktion, die ein spaeterer SES/SNS-Webhook aufruft. Die
 * Datenstruktur und dieser Schreibpfad sind fertig; die automatische
 * Befuellung fehlt noch, weil die IAM-Zugangsdaten fuer das SNS-Abo nicht
 * vorliegen (siehe README/PR).
 */
export const suppressAddress = (
	input: SuppressAddressInput,
	db: Database = openDb(),
): AddressSuppressionRow => {
	const email = normalizeEmail(input.email)
	if (!email) throw new Error('suppressAddress: leere E-Mail-Adresse')
	const listAddress = normalizeListAddress(
		input.list_address ?? GLOBAL_SUPPRESSION,
	)

	db.prepare<{
		email: string
		list_address: string
		reason: string | null
		source: string
		bounce_type: string | null
		bounce_subtype: string | null
	}>(
		`INSERT INTO address_suppressions (
       email, list_address, reason, source, bounce_type, bounce_subtype
     ) VALUES (
       @email, @list_address, @reason, @source, @bounce_type, @bounce_subtype
     )
     ON CONFLICT(email, list_address) DO UPDATE SET
       reason         = COALESCE(excluded.reason, address_suppressions.reason),
       source         = excluded.source,
       bounce_type    = COALESCE(excluded.bounce_type, address_suppressions.bounce_type),
       bounce_subtype = COALESCE(excluded.bounce_subtype, address_suppressions.bounce_subtype),
       event_count    = address_suppressions.event_count + 1,
       last_event_at  = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
	).run({
		email,
		list_address: listAddress,
		reason: input.reason ?? null,
		source: input.source ?? 'bounce',
		bounce_type: input.bounce_type ?? null,
		bounce_subtype: input.bounce_subtype ?? null,
	})

	const row = getAddressSuppression(email, listAddress, db)
	if (!row) throw new Error('suppressAddress: Zeile nach INSERT verschwunden')
	return row
}

export const getAddressSuppression = (
	email: string,
	listAddress: string,
	db: Database = openDb(),
): AddressSuppressionRow | undefined =>
	db
		.prepare<[string, string], AddressSuppressionRow>(
			'SELECT * FROM address_suppressions WHERE email = ? AND list_address = ?',
		)
		.get(normalizeEmail(email), normalizeListAddress(listAddress))

/** Hebt eine Adress-Sperre auf. */
export const unsuppressAddress = (
	email: string,
	listAddress: string = GLOBAL_SUPPRESSION,
	db: Database = openDb(),
): boolean =>
	db
		.prepare<[string, string]>(
			'DELETE FROM address_suppressions WHERE email = ? AND list_address = ?',
		)
		.run(normalizeEmail(email), normalizeListAddress(listAddress)).changes > 0

/** Alle Adress-Sperren, optional auf eine Liste eingegrenzt. */
export const listAddressSuppressions = (
	listAddress?: string,
	db: Database = openDb(),
): AddressSuppressionRow[] =>
	listAddress === undefined
		? db
				.prepare<[], AddressSuppressionRow>(
					'SELECT * FROM address_suppressions ORDER BY email, list_address',
				)
				.all()
		: db
				.prepare<[string], AddressSuppressionRow>(
					'SELECT * FROM address_suppressions WHERE list_address = ? ORDER BY email',
				)
				.all(normalizeListAddress(listAddress))

/**
 * Ist diese Adresse fuer die angegebene Liste (oder global) gesperrt? Wird vom
 * Rundmail-Pfad benutzt, der keine Listenadresse kennt und deshalb nur die
 * globalen Sperren beruecksichtigt.
 */
export const isAddressSuppressed = (
	email: string,
	listAddress: string = GLOBAL_SUPPRESSION,
	db: Database = openDb(),
): boolean =>
	db
		.prepare<[string, string], { one: number }>(
			"SELECT 1 AS one FROM address_suppressions WHERE email = ? AND list_address IN (?, '*') LIMIT 1",
		)
		.get(normalizeEmail(email), normalizeListAddress(listAddress)) !== undefined

/** Alle global gesperrten Adressen (lowercased) als Set. */
export const globallySuppressedAddresses = (
	db: Database = openDb(),
): Set<string> =>
	new Set(
		db
			.prepare<[], { email: string }>(
				"SELECT email FROM address_suppressions WHERE list_address = '*'",
			)
			.all()
			.map((r) => r.email),
	)
