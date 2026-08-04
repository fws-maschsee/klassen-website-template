import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listMitglieder, upsertMitglied } from '../../src/lib/db/members.js'
import { resetGrantsConfig } from '../../src/server/auth/grants.js'
import { syncMembersFromZitadel } from '../../src/server/auth/mirror.js'
import { createTestDb } from '../helpers/db.js'

/**
 * Der Abgleich ist die Stelle, an der aus einem ZITADEL-Grant ein Empfaenger
 * wird. Drei Eigenschaften muessen halten: ein entzogener Grant verschwindet
 * wirklich, von Hand gepflegte Adressen (Grosseltern, Lehrkraefte) ueberleben
 * den Abgleich, und der Schluessel kommt aus dem NAMEN — die ZITADEL-Nummer
 * steht in `zitadel_user_id` und sonst nirgends.
 *
 * DATENSCHUTZ: ausschliesslich erfundene Namen und example.org-Adressen.
 */
const grants = (users: unknown[]) =>
	vi.fn(
		async () =>
			new Response(JSON.stringify({ result: users }), { status: 200 }),
	)

const user = (id: string, first: string, last: string) => ({
	userId: id,
	email: `${first}.${last}@example.org`.toLowerCase(),
	firstName: first,
	lastName: last,
	roleKeys: ['mitglied'],
	state: 'USER_GRANT_STATE_ACTIVE',
})

describe('Abgleich mit ZITADEL', () => {
	let db: Database
	const original = { ...process.env }

	beforeEach(() => {
		db = createTestDb()
		process.env.ZITADEL_ORG_ID = 'org-1'
		process.env.ZITADEL_PROJECT_ID = 'proj-1'
		process.env.ZITADEL_SERVICE_TOKEN = 'tok'
		resetGrantsConfig()
	})

	afterEach(() => {
		process.env = { ...original }
		resetGrantsConfig()
		vi.restoreAllMocks()
	})

	it('legt Empfaenger aus Grants an, mit Schluessel aus dem Namen', async () => {
		vi.stubGlobal('fetch', grants([user('u1', 'Anna', 'Beispiel')]))
		const result = await syncMembersFromZitadel(db)
		expect(result).toMatchObject({ added: 1, removed: 0, total: 1 })
		const row = db
			.prepare('SELECT * FROM mitglieder WHERE id = ?')
			.get('anna-beispiel') as { email: string; zitadel_user_id: string }
		expect(row.email).toBe('anna.beispiel@example.org')
		// Die Nummer bleibt erhalten — aber in ihrer eigenen Spalte.
		expect(row.zitadel_user_id).toBe('u1')
		const inGroup = db
			.prepare('SELECT COUNT(*) c FROM group_memberships WHERE mitglied_id = ?')
			.get('anna-beispiel') as { c: number }
		expect(inGroup.c).toBe(1)
	})

	it('die Nummer bleibt intern: listMitglieder gibt sie nicht heraus', async () => {
		vi.stubGlobal('fetch', grants([user('u1', 'Anna', 'Beispiel')]))
		await syncMembersFromZitadel(db)
		const row = listMitglieder(db)[0]
		expect(row).toBeDefined()
		expect(Object.keys(row)).toEqual([
			'id',
			'first_name',
			'last_name',
			'email',
			'created_at',
			'updated_at',
		])
	})

	it('bei Namensgleichheit bekommt der Schluessel ein Suffix', async () => {
		// Geschwisterkinder und gleichnamige Eltern sind moeglich — deshalb gibt
		// es bewusst keinen UNIQUE-Index auf den Namen.
		upsertMitglied(
			{ first_name: 'Anna', last_name: 'Beispiel', email: 'alt@example.org' },
			db,
		)
		vi.stubGlobal('fetch', grants([user('u1', 'Anna', 'Beispiel')]))
		await syncMembersFromZitadel(db)
		const ids = listMitglieder(db).map((m) => m.id)
		expect(ids).toContain('anna-beispiel')
		expect(ids).toContain('anna-beispiel-2')
	})

	it('schluesselt Zeilen aus der Zeit davor um und nimmt die Verweise mit', async () => {
		// So sah eine gespiegelte Zeile vor der Umstellung aus: die Nummer im
		// Schluessel. Die Migration hat `zitadel_user_id` schon gefuellt.
		db.prepare(
			`INSERT INTO mitglieder (id, first_name, last_name, email, zitadel_user_id)
       VALUES ('zitadel-u1', 'Anna', 'Beispiel', 'anna.beispiel@example.org', 'u1')`,
		).run()
		db.prepare(
			"INSERT INTO group_memberships (group_key, mitglied_id) VALUES ('eltern', 'zitadel-u1')",
		).run()
		db.prepare(
			"INSERT INTO list_suppressions (mitglied_id, list_address, source) VALUES ('zitadel-u1', 'eltern', 'manual')",
		).run()

		vi.stubGlobal('fetch', grants([user('u1', 'Anna', 'Beispiel')]))
		const result = await syncMembersFromZitadel(db)

		expect(result).toMatchObject({ rekeyed: 1, rekeyed_with_suffix: 0 })
		expect(listMitglieder(db).map((m) => m.id)).toEqual(['anna-beispiel'])
		// Der Opt-out haengt weiter an derselben Person — sonst bekaeme jemand
		// Post, der ausdruecklich keine wollte.
		expect(
			db
				.prepare('SELECT mitglied_id FROM list_suppressions')
				.all()
				.map((r) => (r as { mitglied_id: string }).mitglied_id),
		).toEqual(['anna-beispiel'])
		expect(
			db
				.prepare(
					"SELECT COUNT(*) c FROM group_memberships WHERE mitglied_id = 'anna-beispiel'",
				)
				.get(),
		).toMatchObject({ c: 1 })

		// Zweiter Durchlauf: nichts mehr zu tun, der Schritt ist idempotent.
		const again = await syncMembersFromZitadel(db)
		expect(again).toMatchObject({ rekeyed: 0, added: 0 })
	})

	it('entfernt Empfaenger, deren Grant weg ist', async () => {
		vi.stubGlobal('fetch', grants([user('u1', 'Anna', 'Beispiel')]))
		await syncMembersFromZitadel(db)
		vi.stubGlobal('fetch', grants([]))
		const result = await syncMembersFromZitadel(db)
		expect(result.removed).toBe(1)
		expect(
			db.prepare('SELECT * FROM mitglieder WHERE id = ?').get('anna-beispiel'),
		).toBeUndefined()
	})

	it('laesst von Hand gepflegte Eintraege unberuehrt', async () => {
		// Der Grund, warum die Tabelle ueberhaupt bleibt: nicht jeder, der Post
		// bekommen soll, hat einen Zugang.
		upsertMitglied(
			{
				id: 'oma-beispiel',
				first_name: 'Oma',
				last_name: 'Beispiel',
				email: 'oma@example.org',
			},
			db,
		)
		vi.stubGlobal('fetch', grants([user('u1', 'Anna', 'Beispiel')]))
		await syncMembersFromZitadel(db)
		vi.stubGlobal('fetch', grants([]))
		await syncMembersFromZitadel(db)
		expect(
			db.prepare('SELECT * FROM mitglieder WHERE id = ?').get('oma-beispiel'),
		).toBeDefined()
	})

	it('aktualisiert geaenderte Adressen statt zu doppeln', async () => {
		vi.stubGlobal('fetch', grants([user('u1', 'Anna', 'Beispiel')]))
		await syncMembersFromZitadel(db)
		vi.stubGlobal(
			'fetch',
			grants([{ ...user('u1', 'Anna', 'Neu'), email: 'neu@example.org' }]),
		)
		const result = await syncMembersFromZitadel(db)
		expect(result).toMatchObject({ added: 0, updated: 1, total: 1 })
		// Gefunden wird ueber die Nummer, nicht ueber den Namen: der Schluessel
		// bleibt deshalb der alte, obwohl der Nachname sich geaendert hat.
		const rows = listMitglieder(db)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.id).toBe('anna-beispiel')
		expect(rows[0]?.email).toBe('neu@example.org')
	})
})
