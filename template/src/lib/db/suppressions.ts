import type { Database } from 'better-sqlite3'
import { openDb } from './index.js'
import { normalizeEmail } from './mailingLists.js'
import type {
	AddressSuppressionRow,
	ListSuppressionRow,
	SuppressionSource,
} from './types.js'

export const GLOBAL_SUPPRESSION = '*'

const normalizeListAddress = (listAddress: string): string =>
	listAddress === GLOBAL_SUPPRESSION
		? GLOBAL_SUPPRESSION
		: normalizeEmail(listAddress)

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

export const listSuppressionsForAddress = (
	listAddress: string,
	db: Database = openDb(),
): ListSuppressionRow[] =>
	db
		.prepare<[string], ListSuppressionRow>(
			'SELECT * FROM list_suppressions WHERE list_address = ? ORDER BY mitglied_id',
		)
		.all(normalizeListAddress(listAddress))

export type SuppressAddressInput = {
	email: string
	list_address?: string
	source?: SuppressionSource
	reason?: string | null
	bounce_type?: string | null
	bounce_subtype?: string | null
}

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
