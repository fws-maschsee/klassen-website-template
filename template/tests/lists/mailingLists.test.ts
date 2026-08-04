import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { addSubgroup, upsertGroup } from '../../src/lib/db/groups.js'
import {
	getMailingList,
	isSenderAllowed,
	matchesSenderPattern,
	resolveAllowedSenders,
	resolveListRecipients,
	upsertMailingList,
} from '../../src/lib/db/mailingLists.js'
import { addToGroup, upsertMitglied } from '../../src/lib/db/members.js'
import {
	suppressAddress,
	suppressListRecipient,
	unsuppressAddress,
	unsuppressListRecipient,
} from '../../src/lib/db/suppressions.js'
import { createTestDb } from '../helpers/db.js'

/** Alle Namen und Adressen sind frei erfunden. */

let db: Database

const person = (
	id: string,
	email: string | null,
	groups: string[] = ['eltern'],
) =>
	upsertMitglied(
		{
			id,
			first_name: id,
			last_name: 'Beispiel',
			email,
			groups,
		},
		db,
	)

beforeEach(() => {
	db = createTestDb()
	upsertGroup({ key: 'elternvertretung', label: 'Elternvertretung' }, db)
})

describe('upsertMailingList', () => {
	test('verlangt mindestens eine Empfaengerquelle', () => {
		expect(() =>
			upsertMailingList(
				{ address: 'leer', label: 'Leer', recipient_groups: [] },
				db,
			),
		).toThrow(/mindestens eine/)
	})

	test('lehnt unbekannte Gruppen ab, bevor etwas geschrieben wird', () => {
		expect(() =>
			upsertMailingList(
				{ address: 'x', label: 'X', recipient_groups: ['gibtsnicht'] },
				db,
			),
		).toThrow(/Unbekannte Gruppe/)
		expect(getMailingList('x', db)).toBeUndefined()
	})

	test('normalisiert die Adresse und dedupliziert Einzeladressen', () => {
		const list = upsertMailingList(
			{
				address: 'Eltern',
				label: 'Eltern',
				recipient_groups: ['eltern'],
				extra_recipients: ['Buero@Example.org', 'buero@example.org'],
			},
			db,
		)
		expect(list.address).toBe('eltern')
		expect(JSON.parse(list.extra_recipients)).toEqual(['buero@example.org'])
	})
})

describe('Empfaenger aufloesen', () => {
	beforeEach(() => {
		person('anna', 'anna@example.org')
		person('bert', 'bert@example.org')
		person('ohne', null)
		upsertMailingList(
			{
				address: 'eltern',
				label: 'Eltern',
				recipient_groups: ['eltern'],
				extra_recipients: ['buero@example.org'],
			},
			db,
		)
	})

	const recipients = () =>
		resolveListRecipients(getMailingList('eltern', db) as never, db)
			.map((r) => r.email)
			.sort()

	test('nimmt nur Personen mit Adresse und ergaenzt die Einzeladressen', () => {
		expect(recipients()).toEqual([
			'anna@example.org',
			'bert@example.org',
			'buero@example.org',
		])
	})

	test('personengebundener Opt-out entfernt genau diese Person', () => {
		suppressListRecipient('bert', 'eltern', 'moechte nicht', 'manual', db)
		expect(recipients()).toEqual(['anna@example.org', 'buero@example.org'])
		unsuppressListRecipient('bert', 'eltern', db)
		expect(recipients()).toContain('bert@example.org')
	})

	test('globaler Opt-out (*) wirkt auf jeder Liste', () => {
		suppressListRecipient('bert', '*', null, 'manual', db)
		expect(recipients()).not.toContain('bert@example.org')
	})

	test('Adress-Sperre entfernt auch reine Einzeladressen ohne Adressbuch-Eintrag', () => {
		suppressAddress(
			{
				email: 'buero@example.org',
				source: 'bounce',
				bounce_type: 'Permanent',
			},
			db,
		)
		expect(recipients()).toEqual(['anna@example.org', 'bert@example.org'])
		unsuppressAddress('buero@example.org', '*', db)
		expect(recipients()).toContain('buero@example.org')
	})

	test('Adress-Sperre wirkt auch auf Gruppenmitglieder', () => {
		suppressAddress({ email: 'ANNA@example.org', source: 'complaint' }, db)
		expect(recipients()).not.toContain('anna@example.org')
	})

	test('wiederholte Bounce-Meldung zaehlt hoch statt zu duplizieren', () => {
		suppressAddress({ email: 'anna@example.org', source: 'bounce' }, db)
		const row = suppressAddress(
			{ email: 'anna@example.org', source: 'bounce' },
			db,
		)
		expect(row.event_count).toBe(2)
	})

	test('dedupliziert, wenn eine Einzeladresse auch Gruppenmitglied ist', () => {
		upsertMailingList(
			{
				address: 'eltern',
				label: 'Eltern',
				recipient_groups: ['eltern'],
				extra_recipients: ['anna@example.org'],
			},
			db,
		)
		expect(recipients()).toEqual(['anna@example.org', 'bert@example.org'])
	})
})

describe('Absenderberechtigung', () => {
	beforeEach(() => {
		person('anna', 'anna@example.org')
		person('vertreterin', 'vertreterin@example.org', [
			'eltern',
			'elternvertretung',
		])
	})

	test('offen ist die Vorgabe: jede Adresse darf posten', () => {
		const list = upsertMailingList(
			{ address: 'offen', label: 'Offen', recipient_groups: ['eltern'] },
			db,
		)
		expect(list.poster_policy).toBe('offen')
		expect(isSenderAllowed(list, 'irgendwer@fremde.example', db)).toBe(true)
		// Was keine Adresse ist, kommt trotzdem nicht durch.
		expect(isSenderAllowed(list, 'keine-adresse', db)).toBe(false)
	})

	test('eingeschraenkt: nur poster_groups und sender_patterns duerfen posten', () => {
		const list = upsertMailingList(
			{
				address: 'info',
				label: 'Info',
				recipient_groups: ['eltern'],
				poster_policy: 'eingeschraenkt',
				poster_groups: ['elternvertretung'],
				sender_patterns: ['schulbuero@example.org'],
			},
			db,
		)
		expect(isSenderAllowed(list, 'vertreterin@example.org', db)).toBe(true)
		expect(isSenderAllowed(list, 'SCHULBUERO@example.org', db)).toBe(true)
		expect(isSenderAllowed(list, 'anna@example.org', db)).toBe(false)
		expect(isSenderAllowed(list, 'fremd@example.org', db)).toBe(false)
	})

	test('broadcast erlaubt zusaetzlich allen Empfaengern das Posten', () => {
		const list = upsertMailingList(
			{
				address: 'diskussion',
				label: 'Diskussion',
				recipient_groups: ['eltern'],
				poster_policy: 'eingeschraenkt',
				poster_groups: [],
				broadcast: true,
				reply_mode: 'list',
			},
			db,
		)
		expect(isSenderAllowed(list, 'anna@example.org', db)).toBe(true)
		expect(isSenderAllowed(list, 'fremd@example.org', db)).toBe(false)
	})

	test('eingeschraenkt ohne Gruppen und ohne Muster: niemand darf posten', () => {
		const list = upsertMailingList(
			{
				address: 'stumm',
				label: 'Stumm',
				recipient_groups: ['eltern'],
				poster_policy: 'eingeschraenkt',
			},
			db,
		)
		expect(resolveAllowedSenders(list, db).size).toBe(0)
		expect(isSenderAllowed(list, 'anna@example.org', db)).toBe(false)
	})

	test('Poster-Gruppen werden effektiv aufgeloest (Untergruppen duerfen mit)', () => {
		upsertGroup({ key: 'vorstandsteam', label: 'Vorstandsteam' }, db)
		addSubgroup('vorstandsteam', 'elternvertretung', db)
		const list = upsertMailingList(
			{
				address: 'info2',
				label: 'Info',
				recipient_groups: ['eltern'],
				poster_policy: 'eingeschraenkt',
				poster_groups: ['vorstandsteam'],
			},
			db,
		)
		expect(isSenderAllowed(list, 'vertreterin@example.org', db)).toBe(true)
	})

	test('ein gesperrter Empfaenger darf auf einer broadcast-Liste nicht mehr posten', () => {
		const list = upsertMailingList(
			{
				address: 'diskussion2',
				label: 'Diskussion',
				recipient_groups: ['eltern'],
				poster_policy: 'eingeschraenkt',
				broadcast: true,
			},
			db,
		)
		expect(isSenderAllowed(list, 'anna@example.org', db)).toBe(true)
		suppressAddress({ email: 'anna@example.org', source: 'bounce' }, db)
		expect(isSenderAllowed(list, 'anna@example.org', db)).toBe(false)
	})

	test('Domain-Muster erlaubt eine ganze Domain, aber keine Subdomain', () => {
		const list = upsertMailingList(
			{
				address: 'schule',
				label: 'Schule',
				recipient_groups: ['eltern'],
				poster_policy: 'eingeschraenkt',
				sender_patterns: ['*@schule.example'],
			},
			db,
		)
		expect(isSenderAllowed(list, 'buero@schule.example', db)).toBe(true)
		expect(isSenderAllowed(list, 'BUERO@Schule.Example', db)).toBe(true)
		// Eine Subdomain ist eine andere Domain — sonst waere die Freigabe der
		// Schuldomain zugleich die Freigabe jeder Subdomain darunter.
		expect(isSenderAllowed(list, 'buero@mail.schule.example', db)).toBe(false)
		expect(isSenderAllowed(list, 'buero@boese-schule.example', db)).toBe(false)
	})

	test('matchesSenderPattern: die Formen einzeln', () => {
		expect(matchesSenderPattern('anna@example.org', 'anna@example.org')).toBe(
			true,
		)
		expect(matchesSenderPattern('ANNA@Example.org', ' anna@example.org ')).toBe(
			true,
		)
		expect(matchesSenderPattern('anna@example.org', 'bert@example.org')).toBe(
			false,
		)
		expect(matchesSenderPattern('anna@example.org', '*@example.org')).toBe(true)
		expect(matchesSenderPattern('anna@a.example.org', '*@example.org')).toBe(
			false,
		)
		// Ein leeres oder sinnloses Muster darf nie alles treffen.
		expect(matchesSenderPattern('anna@example.org', '')).toBe(false)
		expect(matchesSenderPattern('anna@example.org', '*@')).toBe(false)
		expect(matchesSenderPattern('anna@example.org', '*')).toBe(false)
	})
})

describe('Personen ohne Adressbuch-Eintrag', () => {
	test('Sperre per mitglied_id verlangt einen existierenden Eintrag', () => {
		expect(() =>
			suppressListRecipient('gibtsnicht', 'eltern', null, 'manual', db),
		).toThrow(/Kein Eintrag/)
	})

	test('Sperre per Adresse funktioniert ohne Adressbuch-Eintrag', () => {
		const row = suppressAddress({ email: 'unbekannt@example.org' }, db)
		expect(row.list_address).toBe('*')
		expect(row.source).toBe('bounce')
	})

	test('addToGroup zeigt gruppenspezifische Sperre nur dort', () => {
		person('anna', 'anna@example.org', [])
		addToGroup('eltern', 'anna', db)
		upsertMailingList(
			{ address: 'a', label: 'A', recipient_groups: ['eltern'] },
			db,
		)
		upsertMailingList(
			{ address: 'b', label: 'B', recipient_groups: ['eltern'] },
			db,
		)
		suppressAddress({ email: 'anna@example.org', list_address: 'a' }, db)

		expect(
			resolveListRecipients(getMailingList('a', db) as never, db),
		).toHaveLength(0)
		expect(
			resolveListRecipients(getMailingList('b', db) as never, db),
		).toHaveLength(1)
	})
})
