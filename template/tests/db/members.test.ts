import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { upsertGroup } from '../../src/lib/db/groups.js'
import {
	addToGroup,
	bulkAddToGroup,
	bulkRemoveFromGroup,
	bulkUpsertMitglieder,
	deleteMitglied,
	getMitglied,
	getMitgliedGroups,
	listMitglieder,
	listMitgliederByGroup,
	removeFromGroup,
	searchMitglieder,
	setGroupMembers,
	uniqueMemberId,
	upsertMitglied,
} from '../../src/lib/db/members.js'
import { createTestDb } from '../helpers/db.js'

/** Alle Namen und Adressen in diesen Tests sind frei erfunden. */

let db: Database

beforeEach(() => {
	db = createTestDb()
	upsertGroup({ key: 'elternvertretung', label: 'Elternvertretung' }, db)
})

describe('Schema des Adressbuchs', () => {
	test('kennt nur Name, E-Mail, Zeitstempel und die interne ZITADEL-Nummer', () => {
		const columns = db
			.prepare<[], { name: string }>('PRAGMA table_info(mitglieder)')
			.all()
			.map((c) => c.name)
		expect(columns).toEqual([
			'id',
			'first_name',
			'last_name',
			'email',
			'created_at',
			'updated_at',
			'zitadel_user_id',
		])
	})

	test('listMitglieder gibt die ZITADEL-Nummer NICHT heraus', () => {
		// Sie ist die Verbindung zur Anmeldung und geht weder die Oberflaeche
		// noch einen MCP-Client etwas an.
		upsertMitglied({ id: 'p1', first_name: 'Anna', last_name: 'Beispiel' }, db)
		db.prepare(
			"UPDATE mitglieder SET zitadel_user_id = 'u1' WHERE id = 'p1'",
		).run()
		expect(Object.keys(listMitglieder(db)[0] ?? {})).toEqual([
			'id',
			'first_name',
			'last_name',
			'email',
			'created_at',
			'updated_at',
		])
		expect(Object.keys(getMitglied('p1', db) ?? {})).not.toContain(
			'zitadel_user_id',
		)
	})

	test('uniqueMemberId haengt bei Namensgleichheit -2, -3 an', () => {
		upsertMitglied({ first_name: 'Anna', last_name: 'Beispiel' }, db)
		expect(uniqueMemberId('Anna', 'Beispiel', db)).toBe('anna-beispiel-2')
		upsertMitglied(
			{ id: 'anna-beispiel-2', first_name: 'Anna', last_name: 'Beispiel' },
			db,
		)
		expect(uniqueMemberId('Anna', 'Beispiel', db)).toBe('anna-beispiel-3')
		// Die eigene Zeile zaehlt beim Umschluesseln nicht als Kollision.
		expect(uniqueMemberId('Anna', 'Beispiel', db, 'anna-beispiel')).toBe(
			'anna-beispiel',
		)
	})

	test('Index und Trigger haben den Tabellen-Neubau ueberlebt', () => {
		const objects = db
			.prepare<[], { name: string }>(
				"SELECT name FROM sqlite_master WHERE tbl_name = 'mitglieder' AND type IN ('index', 'trigger') ORDER BY name",
			)
			.all()
			.map((o) => o.name)
		expect(objects).toContain('idx_mitglieder_email')
		expect(objects).toContain('trg_mitglieder_updated_at')
	})

	test('der Tabellen-Neubau hat die Gruppenzuordnungen nicht mitgerissen', () => {
		// Der Neubau in der Migration laeuft mit abgeschalteten
		// Fremdschluesseln — sonst wuerde das DROP TABLE alle
		// `group_memberships` per CASCADE mitnehmen. Danach muessen sie wieder
		// scharf sein, sonst faellt es erst produktiv auf.
		upsertMitglied(
			{
				id: 'p1',
				first_name: 'Anna',
				last_name: 'Beispiel',
				groups: ['eltern'],
			},
			db,
		)
		expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
		deleteMitglied('p1', db)
		expect(listMitgliederByGroup('eltern', db)).toEqual([])
	})
})

describe('upsertMitglied', () => {
	test('leitet die ID aus dem Namen ab und entschaerft Umlaute', () => {
		const row = upsertMitglied(
			{ first_name: 'Jörg', last_name: 'Müller-Groß' },
			db,
		)
		expect(row.id).toBe('joerg-mueller-gross')
	})

	test('partielles Update: weggelassene Felder bleiben unveraendert', () => {
		upsertMitglied(
			{
				id: 'p1',
				first_name: 'Anna',
				last_name: 'Beispiel',
				email: 'anna@example.org',
			},
			db,
		)
		upsertMitglied({ id: 'p1', first_name: 'Anna', last_name: 'Muster' }, db)
		const row = getMitglied('p1', db)
		expect(row?.last_name).toBe('Muster')
		expect(row?.email).toBe('anna@example.org')
	})

	test('explizites null leert ein Feld', () => {
		upsertMitglied(
			{
				id: 'p1',
				first_name: 'Anna',
				last_name: 'Beispiel',
				email: 'anna@example.org',
			},
			db,
		)
		upsertMitglied(
			{ id: 'p1', first_name: 'Anna', last_name: 'Beispiel', email: null },
			db,
		)
		expect(getMitglied('p1', db)?.email).toBeNull()
	})

	test('groups: weggelassen laesst Mitgliedschaften unveraendert, [] leert sie', () => {
		upsertMitglied(
			{
				id: 'p1',
				first_name: 'Anna',
				last_name: 'Beispiel',
				groups: ['eltern', 'elternvertretung'],
			},
			db,
		)
		upsertMitglied({ id: 'p1', first_name: 'Anna', last_name: 'Beispiel' }, db)
		expect(getMitgliedGroups('p1', db)).toEqual(['eltern', 'elternvertretung'])

		upsertMitglied(
			{ id: 'p1', first_name: 'Anna', last_name: 'Beispiel', groups: [] },
			db,
		)
		expect(getMitgliedGroups('p1', db)).toEqual([])
	})

	test('unbekannter Group-Key wird abgelehnt', () => {
		expect(() =>
			upsertMitglied(
				{ first_name: 'Anna', last_name: 'Beispiel', groups: ['gibtsnicht'] },
				db,
			),
		).toThrow(/Unbekannte Gruppe/)
	})

	test('bulkUpsertMitglieder schreibt nichts, wenn ein Eintrag scheitert', () => {
		expect(() =>
			bulkUpsertMitglieder(
				[
					{ id: 'ok', first_name: 'Anna', last_name: 'B' },
					{
						id: 'kaputt',
						first_name: 'Bert',
						last_name: 'B',
						groups: ['gibtsnicht'],
					},
				],
				db,
			),
		).toThrow()
		expect(getMitglied('ok', db)).toBeUndefined()
	})

	test('deleteMitglied raeumt die Mitgliedschaften mit ab (FK CASCADE)', () => {
		upsertMitglied(
			{
				id: 'p1',
				first_name: 'Anna',
				last_name: 'Beispiel',
				groups: ['eltern'],
			},
			db,
		)
		deleteMitglied('p1', db)
		expect(listMitgliederByGroup('eltern', db)).toEqual([])
	})
})

describe('Gruppen-Mitgliedschaften pflegen', () => {
	beforeEach(() => {
		for (const id of ['a', 'b', 'c']) {
			upsertMitglied({ id, first_name: id, last_name: 'Beispiel' }, db)
		}
	})

	test('addToGroup ist idempotent, removeFromGroup vertraegt Unbekanntes', () => {
		addToGroup('eltern', 'a', db)
		addToGroup('eltern', 'a', db)
		expect(listMitgliederByGroup('eltern', db).map((m) => m.id)).toEqual(['a'])
		removeFromGroup('eltern', 'b', db)
		expect(listMitgliederByGroup('eltern', db).map((m) => m.id)).toEqual(['a'])
	})

	test('addToGroup lehnt unbekannte Person und unbekannte Gruppe ab', () => {
		expect(() => addToGroup('eltern', 'gibtsnicht', db)).toThrow(/Kein Eintrag/)
		expect(() => addToGroup('gibtsnicht', 'a', db)).toThrow(/Unbekannte Gruppe/)
	})

	test('bulkAddToGroup validiert alle IDs vorab', () => {
		expect(() => bulkAddToGroup('eltern', ['a', 'gibtsnicht'], db)).toThrow()
		expect(listMitgliederByGroup('eltern', db)).toEqual([])
	})

	test('bulkAddToGroup meldet nur die wirklich neuen', () => {
		addToGroup('eltern', 'a', db)
		const result = bulkAddToGroup('eltern', ['a', 'b'], db)
		expect(result.added).toEqual(['b'])
		expect(result.members.sort()).toEqual(['a', 'b'])
	})

	test('bulkRemoveFromGroup meldet nur die wirklich entfernten', () => {
		bulkAddToGroup('eltern', ['a', 'b'], db)
		const result = bulkRemoveFromGroup('eltern', ['b', 'c'], db)
		expect(result.removed).toEqual(['b'])
		expect(result.members).toEqual(['a'])
	})

	test('setGroupMembers liefert das Diff und entfernt Nichtgenannte', () => {
		bulkAddToGroup('eltern', ['a', 'b'], db)
		const result = setGroupMembers('eltern', ['b', 'c'], db)
		expect(result.added).toEqual(['c'])
		expect(result.removed).toEqual(['a'])
		expect(result.members.sort()).toEqual(['b', 'c'])
	})
})

describe('searchMitglieder', () => {
	beforeEach(() => {
		upsertMitglied(
			{
				id: 'doss',
				first_name: 'Doris',
				last_name: 'Doß',
				email: 'doris@example.org',
				groups: ['eltern'],
			},
			db,
		)
		upsertMitglied(
			{ id: 'ohne', first_name: 'Otto', last_name: 'Ohnemail' },
			db,
		)
	})

	test('ist diakritik- und case-insensitiv', () => {
		expect(searchMitglieder({ query: 'doss' }, db).map((m) => m.id)).toEqual([
			'doss',
		])
		expect(searchMitglieder({ query: 'DOSS' }, db).map((m) => m.id)).toEqual([
			'doss',
		])
	})

	test('durchsucht auch die E-Mail-Adresse', () => {
		expect(
			searchMitglieder({ query: 'doris@example' }, db).map((m) => m.id),
		).toEqual(['doss'])
	})

	test('filtert nach has_email', () => {
		expect(searchMitglieder({ has_email: false }, db).map((m) => m.id)).toEqual(
			['ohne'],
		)
	})

	test('ohne Treffer kommt eine leere Liste (nicht raten)', () => {
		expect(searchMitglieder({ query: 'existiertnicht' }, db)).toEqual([])
	})
})
