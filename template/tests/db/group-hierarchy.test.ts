import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import {
	addSubgroup,
	ancestorGroupKeys,
	deleteGroup,
	effectiveMemberCount,
	expandToSubtrees,
	listChildGroups,
	listGroups,
	listParentGroups,
	removeSubgroup,
	setSubgroups,
	subtreeGroupKeys,
	upsertGroup,
	wouldCreateCycle,
} from '../../src/lib/db/groups.js'
import {
	resolveListRecipients,
	upsertMailingList,
} from '../../src/lib/db/mailingLists.js'
import {
	addToGroup,
	listMitgliederByGroup,
	listMitgliederByGroupEffective,
	searchMitglieder,
	upsertMitglied,
} from '../../src/lib/db/members.js'
import { resolveRecipients } from '../../src/lib/emails/recipients.js'
import { createTestDb } from '../helpers/db.js'

/**
 * Die rekursive Gruppenaufloesung und die Zykluspruefung sind die Stellen, an
 * denen ein Fehler richtig teuer wird: Entweder bekommt jemand Post, der sie
 * nicht bekommen darf, oder eine Endlosschleife legt den Versand lahm.
 *
 * Alle Namen hier sind frei erfunden.
 */

let db: Database

const seedPerson = (id: string, email: string | null = `${id}@example.org`) =>
	upsertMitglied({ id, first_name: id, last_name: 'Beispiel', email }, db)

beforeEach(() => {
	db = createTestDb()
	// 'eltern' kommt aus der Migration. Dazu drei Untergruppen zum Spielen.
	upsertGroup({ key: 'ag-basar', label: 'AG Basar' }, db)
	upsertGroup({ key: 'ag-garten', label: 'AG Garten' }, db)
	upsertGroup({ key: 'elternvertretung', label: 'Elternvertretung' }, db)
})

describe('effektive Mitgliedschaft', () => {
	test('Obergruppe erreicht die Mitglieder ihrer Untergruppen', () => {
		seedPerson('anna')
		seedPerson('bert')
		addToGroup('ag-basar', 'anna', db)
		addToGroup('ag-garten', 'bert', db)
		addSubgroup('eltern', 'ag-basar', db)
		addSubgroup('eltern', 'ag-garten', db)

		// Direkt: keine eigenen Mitglieder. Effektiv: beide.
		expect(listMitgliederByGroup('eltern', db)).toEqual([])
		expect(
			listMitgliederByGroupEffective('eltern', db)
				.map((m) => m.id)
				.sort(),
		).toEqual(['anna', 'bert'])
	})

	test('dedupliziert Personen, die in mehreren Untergruppen sind', () => {
		seedPerson('anna')
		addToGroup('ag-basar', 'anna', db)
		addToGroup('ag-garten', 'anna', db)
		addSubgroup('eltern', 'ag-basar', db)
		addSubgroup('eltern', 'ag-garten', db)

		expect(
			listMitgliederByGroupEffective('eltern', db).map((m) => m.id),
		).toEqual(['anna'])
		expect(effectiveMemberCount('eltern', db)).toBe(1)
	})

	test('Mischbetrieb: direkte Mitglieder UND Untergruppen', () => {
		seedPerson('anna')
		seedPerson('bert')
		addToGroup('eltern', 'anna', db)
		addToGroup('ag-basar', 'bert', db)
		addSubgroup('eltern', 'ag-basar', db)

		expect(listMitgliederByGroup('eltern', db).map((m) => m.id)).toEqual([
			'anna',
		])
		expect(
			listMitgliederByGroupEffective('eltern', db)
				.map((m) => m.id)
				.sort(),
		).toEqual(['anna', 'bert'])
	})

	test('loest ueber mehrere Ebenen hinweg auf', () => {
		seedPerson('tief')
		addToGroup('ag-garten', 'tief', db)
		addSubgroup('elternvertretung', 'ag-garten', db)
		addSubgroup('eltern', 'elternvertretung', db)

		expect(subtreeGroupKeys('eltern', db).sort()).toEqual([
			'ag-garten',
			'eltern',
			'elternvertretung',
		])
		expect(
			listMitgliederByGroupEffective('eltern', db).map((m) => m.id),
		).toEqual(['tief'])
	})

	test('Diamant: zwei Wege zur selben Untergruppe liefern die Person einmal', () => {
		seedPerson('anna')
		addToGroup('ag-garten', 'anna', db)
		addSubgroup('eltern', 'ag-garten', db)
		addSubgroup('elternvertretung', 'ag-garten', db)
		addSubgroup('eltern', 'elternvertretung', db)

		expect(
			listMitgliederByGroupEffective('eltern', db).map((m) => m.id),
		).toEqual(['anna'])
	})

	test('ohne Untergruppen identisch zur direkten Mitgliedschaft', () => {
		seedPerson('anna')
		addToGroup('eltern', 'anna', db)
		expect(listMitgliederByGroupEffective('eltern', db)).toEqual(
			listMitgliederByGroup('eltern', db),
		)
	})
})

describe('Zyklusschutz', () => {
	test('lehnt die direkte Selbstkante ab', () => {
		expect(() => addSubgroup('eltern', 'eltern', db)).toThrow(
			/eigene Untergruppe/,
		)
		expect(wouldCreateCycle('eltern', 'eltern', db)).toBe(true)
	})

	test('lehnt die Rueckkante eines bestehenden Pfads ab', () => {
		addSubgroup('eltern', 'elternvertretung', db)
		expect(wouldCreateCycle('elternvertretung', 'eltern', db)).toBe(true)
		expect(() => addSubgroup('elternvertretung', 'eltern', db)).toThrow(
			/Zyklus/,
		)
	})

	test('lehnt einen indirekten Zyklus ueber drei Ebenen ab', () => {
		addSubgroup('eltern', 'elternvertretung', db)
		addSubgroup('elternvertretung', 'ag-basar', db)
		expect(() => addSubgroup('ag-basar', 'eltern', db)).toThrow(/Zyklus/)
	})

	test('erlaubt einen Diamanten (mehrere Eltern sind kein Zyklus)', () => {
		addSubgroup('eltern', 'ag-basar', db)
		expect(() => addSubgroup('elternvertretung', 'ag-basar', db)).not.toThrow()
		expect(listParentGroups('ag-basar', db)).toEqual([
			'eltern',
			'elternvertretung',
		])
	})

	test('setSubgroups schreibt gar nichts, wenn ein Kandidat einen Zyklus erzeugt', () => {
		addSubgroup('eltern', 'elternvertretung', db)
		expect(() =>
			setSubgroups('elternvertretung', ['ag-basar', 'eltern'], db),
		).toThrow(/Zyklus/)
		// ag-basar darf NICHT angelegt worden sein: Validierung vor dem Schreiben.
		expect(listChildGroups('elternvertretung', db)).toEqual([])
	})

	test('unbekannte Gruppen werden abgelehnt', () => {
		expect(() => addSubgroup('eltern', 'gibtsnicht', db)).toThrow(/Unbekannte/)
		expect(() => addSubgroup('gibtsnicht', 'eltern', db)).toThrow(/Unbekannte/)
	})
})

describe('Hierarchie pflegen', () => {
	test('addSubgroup ist idempotent', () => {
		addSubgroup('eltern', 'ag-basar', db)
		addSubgroup('eltern', 'ag-basar', db)
		expect(listChildGroups('eltern', db)).toEqual(['ag-basar'])
	})

	test('removeSubgroup loest nur die Kante, nicht die Gruppe', () => {
		seedPerson('anna')
		addToGroup('ag-basar', 'anna', db)
		addSubgroup('eltern', 'ag-basar', db)
		removeSubgroup('eltern', 'ag-basar', db)

		expect(listChildGroups('eltern', db)).toEqual([])
		expect(listMitgliederByGroup('ag-basar', db).map((m) => m.id)).toEqual([
			'anna',
		])
	})

	test('setSubgroups liefert das Diff', () => {
		addSubgroup('eltern', 'ag-basar', db)
		const result = setSubgroups('eltern', ['ag-garten', 'elternvertretung'], db)
		expect(result.added.sort()).toEqual(['ag-garten', 'elternvertretung'])
		expect(result.removed).toEqual(['ag-basar'])
		expect(result.children).toEqual(['ag-garten', 'elternvertretung'])
	})

	test('setSubgroups mit leerem Array loest alle Kanten', () => {
		addSubgroup('eltern', 'ag-basar', db)
		expect(setSubgroups('eltern', [], db).children).toEqual([])
	})

	test('deleteGroup raeumt die Kanten in beide Richtungen ab', () => {
		addSubgroup('eltern', 'elternvertretung', db)
		addSubgroup('elternvertretung', 'ag-basar', db)
		deleteGroup('elternvertretung', db)

		expect(listChildGroups('eltern', db)).toEqual([])
		expect(listParentGroups('ag-basar', db)).toEqual([])
	})

	test('ancestorGroupKeys liefert alle Obergruppen ohne die Gruppe selbst', () => {
		addSubgroup('eltern', 'elternvertretung', db)
		addSubgroup('elternvertretung', 'ag-basar', db)
		expect(ancestorGroupKeys('ag-basar', db).sort()).toEqual([
			'eltern',
			'elternvertretung',
		])
	})

	test('expandToSubtrees dedupliziert ueber mehrere Startknoten', () => {
		addSubgroup('eltern', 'ag-basar', db)
		addSubgroup('elternvertretung', 'ag-basar', db)
		expect(expandToSubtrees(['eltern', 'elternvertretung'], db).sort()).toEqual(
			['ag-basar', 'eltern', 'elternvertretung'],
		)
	})

	test('listGroups zeigt direkte und effektive Zahl getrennt', () => {
		seedPerson('anna')
		addToGroup('ag-basar', 'anna', db)
		addSubgroup('eltern', 'ag-basar', db)

		const eltern = listGroups(db).find((g) => g.key === 'eltern')
		expect(eltern?.mitglieder).toBe(0)
		expect(eltern?.mitglieder_effektiv).toBe(1)
		expect(eltern?.children).toEqual(['ag-basar'])
	})
})

describe('effektive Aufloesung greift ueberall, wo Gruppen Personen liefern', () => {
	beforeEach(() => {
		seedPerson('anna')
		addToGroup('ag-basar', 'anna', db)
		addSubgroup('eltern', 'ag-basar', db)
	})

	test('Rundmail-Empfaenger', () => {
		expect(
			resolveRecipients({ kind: 'group', value: 'eltern' }, db).map(
				(m) => m.id,
			),
		).toEqual(['anna'])
	})

	test('Mailinglisten-Empfaenger', () => {
		const list = upsertMailingList(
			{ address: 'eltern', label: 'Eltern', recipient_groups: ['eltern'] },
			db,
		)
		expect(resolveListRecipients(list, db).map((r) => r.mitglied_id)).toEqual([
			'anna',
		])
	})

	test('Suche mit Gruppenfilter', () => {
		expect(searchMitglieder({ group: 'eltern' }, db).map((m) => m.id)).toEqual([
			'anna',
		])
	})
})
