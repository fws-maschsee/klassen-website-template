import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { upsertMitglied } from '../../src/lib/db/members.js'
import { renderForRecipient } from '../../src/lib/email/render.js'
import {
	listEmailSlugs,
	loadAllEmails,
	loadEmail,
} from '../../src/lib/emails/loader.js'
import { resolveRecipients } from '../../src/lib/emails/recipients.js'
import { createTestDb } from '../helpers/db.js'

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'emails')

let db: Database

beforeEach(() => {
	db = createTestDb()
})

describe('loader', () => {
	test('ignoriert Dateien mit Unterstrich-Praefix und sortiert neueste zuerst', () => {
		expect(listEmailSlugs(FIXTURES)).toEqual([
			'2026-08-02-gestoppt',
			'2026-08-01-testmail',
		])
	})

	test('laedt den default-Export', async () => {
		const email = await loadEmail('2026-08-01-testmail', FIXTURES)
		expect(email.subject).toBe('Testmail fuer {{firstName}}')
	})

	test('meldet eine fehlende Datei verstaendlich', async () => {
		await expect(loadEmail('gibtsnicht', FIXTURES)).rejects.toThrow(
			/nicht gefunden/,
		)
	})

	test('loadAllEmails liefert alle Mails mit ihrem Slug', async () => {
		expect((await loadAllEmails(FIXTURES)).map((e) => e.slug)).toEqual([
			'2026-08-02-gestoppt',
			'2026-08-01-testmail',
		])
	})
})

describe('Rendern und Personalisieren', () => {
	test('ersetzt die Marker und erzeugt HTML plus Plaintext', async () => {
		const mitglied = upsertMitglied(
			{
				id: 'anna',
				first_name: 'Anna',
				last_name: 'Beispiel',
				email: 'anna@example.org',
			},
			db,
		)
		const email = await loadEmail('2026-08-01-testmail', FIXTURES)
		const rendered = await renderForRecipient(email, mitglied)

		expect(rendered.subject).toBe('Testmail fuer Anna')
		// `{{anrede}}` spricht ueber den Vornamen an, ohne Geschlechtsangabe.
		expect(rendered.html).toContain('Hallo Anna,')
		expect(rendered.text).toContain('Hallo Anna,')
		expect(rendered.html).toContain('<html')
	})

	test('die Anrede kommt ohne Geschlechtsangabe aus', async () => {
		const mitglied = upsertMitglied(
			{
				id: 'bert',
				first_name: 'Bert',
				last_name: 'Beispiel',
			},
			db,
		)
		const email = await loadEmail('2026-08-01-testmail', FIXTURES)
		const rendered = await renderForRecipient(email, mitglied)
		expect(rendered.text).toContain('Hallo Bert,')
		expect(rendered.text).not.toMatch(/Herr|Frau|Sehr geehrte/)
	})
})

describe('resolveRecipients', () => {
	beforeEach(() => {
		for (const id of ['a', 'b']) {
			upsertMitglied(
				{
					id,
					first_name: id,
					last_name: 'Beispiel',
					email: `${id}@example.org`,
					groups: ['eltern'],
				},
				db,
			)
		}
	})

	test('explicit liefert genau die angefragten IDs', () => {
		expect(
			resolveRecipients({ kind: 'explicit', ids: ['b'] }, db).map((m) => m.id),
		).toEqual(['b'])
	})

	test('union dedupliziert ueber die Mitglieds-ID', () => {
		const ids = resolveRecipients(
			{
				kind: 'union',
				of: [
					{ kind: 'group', value: 'eltern' },
					{ kind: 'explicit', ids: ['a'] },
				],
			},
			db,
		).map((m) => m.id)
		expect(ids).toEqual(['a', 'b'])
	})
})
