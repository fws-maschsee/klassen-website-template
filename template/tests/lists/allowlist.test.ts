import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { upsertGroup } from '../../src/lib/db/groups.js'
import {
	resolveListRecipients,
	upsertMailingList,
} from '../../src/lib/db/mailingLists.js'
import { upsertMitglied } from '../../src/lib/db/members.js'
import { createTestDb } from '../helpers/db.js'

/**
 * Das Sicherheitsventil fuer die Erprobung. Seit die Empfaenger aus den
 * ZITADEL-Grants kommen, stehen dort echte Elternadressen — ein
 * versehentlicher Versand waere nicht zurueckzuholen.
 */
describe('LIST_RECIPIENT_ALLOWLIST', () => {
	let db: Database
	const original = process.env.LIST_RECIPIENT_ALLOWLIST

	beforeEach(() => {
		db = createTestDb()
		upsertGroup({ key: 'eltern', label: 'Eltern' }, db)
		for (const [id, email] of [
			['a', 'darf@example.org'],
			['b', 'darf-nicht@fremd.example'],
			['c', 'auch-nicht@fremd.example'],
		]) {
			upsertMitglied(
				{
					id,
					first_name: id,
					last_name: 'Test',
					email,
					groups: ['eltern'],
				},
				db,
			)
		}
		upsertMailingList(
			{ address: 'eltern', label: 'Eltern', recipient_groups: ['eltern'] },
			db,
		)
	})

	afterEach(() => {
		if (original === undefined) delete process.env.LIST_RECIPIENT_ALLOWLIST
		else process.env.LIST_RECIPIENT_ALLOWLIST = original
	})

	const list = () => {
		const row = db
			.prepare('SELECT * FROM mailing_lists WHERE address = ?')
			.get('eltern')
		return row as Parameters<typeof resolveListRecipients>[0]
	}

	it('verteilt ohne Variable an alle', () => {
		delete process.env.LIST_RECIPIENT_ALLOWLIST
		expect(resolveListRecipients(list(), db)).toHaveLength(3)
	})

	it('laesst nur genannte Adressen durch', () => {
		process.env.LIST_RECIPIENT_ALLOWLIST = 'darf@example.org'
		const result = resolveListRecipients(list(), db)
		expect(result.map((r) => r.email)).toEqual(['darf@example.org'])
	})

	it('erlaubt eine ganze Domain mit fuehrendem @', () => {
		process.env.LIST_RECIPIENT_ALLOWLIST = '@fremd.example'
		const result = resolveListRecipients(list(), db)
		expect(result).toHaveLength(2)
	})

	it('vergleicht ohne Ruecksicht auf Gross-/Kleinschreibung', () => {
		process.env.LIST_RECIPIENT_ALLOWLIST = ' DARF@Example.ORG '
		expect(resolveListRecipients(list(), db)).toHaveLength(1)
	})
})
