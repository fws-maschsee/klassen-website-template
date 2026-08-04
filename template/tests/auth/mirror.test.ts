import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertMitglied } from '../../src/lib/db/members.js'
import { resetGrantsConfig } from '../../src/server/auth/grants.js'
import { syncMembersFromZitadel } from '../../src/server/auth/mirror.js'
import { createTestDb } from '../helpers/db.js'

/**
 * Der Abgleich ist die Stelle, an der aus einem ZITADEL-Grant ein Empfaenger
 * wird. Zwei Eigenschaften muessen halten: ein entzogener Grant verschwindet
 * wirklich, und von Hand gepflegte Adressen (Grosseltern, Lehrkraefte)
 * ueberleben den Abgleich.
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

	it('legt Empfaenger aus Grants an', async () => {
		vi.stubGlobal('fetch', grants([user('u1', 'Anna', 'Beispiel')]))
		const result = await syncMembersFromZitadel(db)
		expect(result).toMatchObject({ added: 1, removed: 0, total: 1 })
		const row = db
			.prepare('SELECT * FROM mitglieder WHERE id = ?')
			.get('zitadel-u1') as { email: string }
		expect(row.email).toBe('anna.beispiel@example.org')
		const inGroup = db
			.prepare('SELECT COUNT(*) c FROM group_memberships WHERE mitglied_id = ?')
			.get('zitadel-u1') as { c: number }
		expect(inGroup.c).toBe(1)
	})

	it('entfernt Empfaenger, deren Grant weg ist', async () => {
		vi.stubGlobal('fetch', grants([user('u1', 'Anna', 'Beispiel')]))
		await syncMembersFromZitadel(db)
		vi.stubGlobal('fetch', grants([]))
		const result = await syncMembersFromZitadel(db)
		expect(result.removed).toBe(1)
		expect(
			db.prepare('SELECT * FROM mitglieder WHERE id = ?').get('zitadel-u1'),
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
		const count = db
			.prepare("SELECT COUNT(*) c FROM mitglieder WHERE id LIKE 'zitadel-%'")
			.get() as { c: number }
		expect(count.c).toBe(1)
	})
})
