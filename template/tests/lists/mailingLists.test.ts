import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { addSubgroup, upsertGroup } from '../../src/lib/db/groups.js'
import {
	getMailingList,
	isSenderAllowed,
	listSenderPatterns,
	resolveAllowedSenders,
	resolveListRecipients,
	setListPosterRules,
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

	test('nur poster_groups und sender_patterns duerfen posten', () => {
		const list = upsertMailingList(
			{
				address: 'info',
				label: 'Info',
				recipient_groups: ['eltern'],
				poster_groups: ['elternvertretung'],

				poster_policy: 'eingeschraenkt',
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
				poster_groups: [],

				poster_policy: 'eingeschraenkt',
				broadcast: true,
				reply_mode: 'list',
			},
			db,
		)
		expect(isSenderAllowed(list, 'anna@example.org', db)).toBe(true)
		expect(isSenderAllowed(list, 'fremd@example.org', db)).toBe(false)
	})

	test('eingeschraenkt und ohne alles: niemand darf posten', () => {
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
				poster_groups: ['vorstandsteam'],

				poster_policy: 'eingeschraenkt',
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
})

describe('Migration auf poster_policy', () => {
	/**
	 * Der wichtigste Test dieser Datei: Die Migration darf das Verhalten der
	 * BEIDEN LAUFENDEN Klassen nicht anfassen. Eine Liste, die es vor der
	 * Migration schon gab, muss danach genauso streng sein wie vorher — offen
	 * wird nur, was jemand ausdruecklich umstellt. Simuliert wird der Bestand,
	 * indem die Zeile am ORM vorbei so geschrieben wird, wie die alte
	 * Anwendung sie geschrieben haette (ohne poster_policy).
	 */
	test('eine Liste aus der Zeit davor bleibt eingeschraenkt', () => {
		person('anna', 'anna@example.org')
		person('vertreterin', 'vertreterin@example.org', [
			'eltern',
			'elternvertretung',
		])
		db.prepare(
			`INSERT INTO mailing_lists (address, label, recipient_groups, poster_groups, sender_patterns, poster_policy)
       VALUES ('alt', 'Alt', '["eltern"]', '["elternvertretung"]', '[]', 'eingeschraenkt')`,
		).run()
		const list = getMailingList('alt', db)
		if (!list) throw new Error('Liste nicht angelegt')
		expect(list.poster_policy).toBe('eingeschraenkt')
		expect(isSenderAllowed(list, 'vertreterin@example.org', db)).toBe(true)
		expect(isSenderAllowed(list, 'wildfremd@irgendwo.example', db)).toBe(false)
	})

	test('die Spalte selbst haelt nur die beiden erlaubten Werte aus', () => {
		expect(() =>
			db
				.prepare(
					`INSERT INTO mailing_lists (address, label, poster_policy)
           VALUES ('quatsch', 'Quatsch', 'vielleicht')`,
				)
				.run(),
		).toThrow(/CHECK/)
	})

	test('der Spalten-Default ist offen — fuer alles, was neu entsteht', () => {
		db.prepare(
			"INSERT INTO mailing_lists (address, label) VALUES ('frisch', 'Frisch')",
		).run()
		expect(getMailingList('frisch', db)?.poster_policy).toBe('offen')
	})
})

describe('poster_policy', () => {
	beforeEach(() => {
		person('anna', 'anna@example.org')
	})

	const liste = (address: string, rest = {}) =>
		upsertMailingList(
			{ address, label: address, recipient_groups: ['eltern'], ...rest },
			db,
		)

	test('neue Listen sind offen — das ist die Vorgabe', () => {
		expect(liste('neu').poster_policy).toBe('offen')
	})

	test('offen laesst auch voellig Fremde schreiben', () => {
		const list = liste('offen')
		expect(isSenderAllowed(list, 'wildfremd@irgendwo.example', db)).toBe(true)
		// Auch ohne jede Poster-Gruppe und ohne jedes Muster.
		expect(resolveAllowedSenders(list, db).size).toBe(0)
	})

	test('eingeschraenkt lehnt Fremdabsender ab', () => {
		const list = liste('zu', { poster_policy: 'eingeschraenkt' })
		expect(isSenderAllowed(list, 'wildfremd@irgendwo.example', db)).toBe(false)
	})

	test('eine volle Adresse im Muster trifft genau diese Adresse', () => {
		const list = liste('voll', {
			poster_policy: 'eingeschraenkt',
			sender_patterns: ['schulbuero@schule.example'],
		})
		expect(isSenderAllowed(list, 'schulbuero@schule.example', db)).toBe(true)
		expect(isSenderAllowed(list, 'anders@schule.example', db)).toBe(false)
	})

	test('*@domain trifft jede Adresse dieser Domain', () => {
		const list = liste('domain', {
			poster_policy: 'eingeschraenkt',
			sender_patterns: ['*@schule.example'],
		})
		expect(isSenderAllowed(list, 'wer@schule.example', db)).toBe(true)
		expect(isSenderAllowed(list, 'jemand.anderes@schule.example', db)).toBe(
			true,
		)
		expect(isSenderAllowed(list, 'wer@example.org', db)).toBe(false)
	})

	test('*@domain trifft NICHT eine Subdomain davon', () => {
		// Sonst duerfte, wer irgendeine Subdomain kontrolliert, an alle Familien
		// schreiben. Das soll ueberraschen, wenn man es erwartet — nicht, wenn
		// man es nicht erwartet.
		const list = liste('sub', {
			poster_policy: 'eingeschraenkt',
			sender_patterns: ['*@example.org'],
		})
		expect(isSenderAllowed(list, 'wer@example.org', db)).toBe(true)
		expect(isSenderAllowed(list, 'wer@mail.example.org', db)).toBe(false)
		expect(isSenderAllowed(list, 'wer@example.org.example', db)).toBe(false)
	})

	test('Grossschreibung ist egal — beim Muster wie bei der Adresse', () => {
		const list = liste('gross', {
			poster_policy: 'eingeschraenkt',
			sender_patterns: ['*@Schule.EXAMPLE', 'Anna@Example.ORG'],
		})
		expect(isSenderAllowed(list, 'WER@schule.example', db)).toBe(true)
		expect(isSenderAllowed(list, 'ANNA@example.org', db)).toBe(true)
	})

	test('unsinnige Muster werden beim Speichern abgelehnt', () => {
		for (const kaputt of [
			'*',
			'*@',
			'ohne-at',
			'an*@example.org',
			'@example.org',
		]) {
			expect(() =>
				liste('kaputt', {
					poster_policy: 'eingeschraenkt',
					sender_patterns: [kaputt],
				}),
			).toThrow(/Absender-Muster|Domain-Platzhalter/)
		}
	})

	test('setListPosterRules aendert nur Richtlinie und Muster', () => {
		const before = liste('umstellen', {
			poster_policy: 'eingeschraenkt',
			poster_groups: ['elternvertretung'],
			subject_prefix: '[Test]',
		})
		const after = setListPosterRules(
			'umstellen',
			'offen',
			['*@schule.example'],
			db,
		)
		expect(after.poster_policy).toBe('offen')
		expect(listSenderPatterns(after)).toEqual(['*@schule.example'])
		expect(after.poster_groups).toBe(before.poster_groups)
		expect(after.subject_prefix).toBe('[Test]')
	})

	test('setListPosterRules wirft bei unbekannter Liste', () => {
		expect(() => setListPosterRules('gibtsnicht', 'offen', [], db)).toThrow(
			/Unbekannte Liste/,
		)
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
