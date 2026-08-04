import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { addSubgroup, upsertGroup } from '../../src/lib/db/groups.js'
import { upsertMailingList } from '../../src/lib/db/mailingLists.js'
import { upsertMitglied } from '../../src/lib/db/members.js'
import { verteilerUebersicht } from '../../src/lib/lists/uebersicht.js'
import { createTestDb } from '../helpers/db.js'

/**
 * Die Verteiler-Uebersicht ist die Antwort auf einen echten Fehler: Die
 * Adressen standen von Hand in Markdown, und der Text ist veraltet, waehrend
 * die Anwendung laengst woanders zustellte. Deshalb pruefen diese Tests vor
 * allem zwei Dinge — dass die Angaben aus der DATENBANK kommen, und dass die
 * Seite dabei nichts Personenbezogenes ausplaudert.
 *
 * DATENSCHUTZ: ausschliesslich erfundene Namen und example.org-Adressen.
 */

let db: Database
const original = { ...process.env }

/** Ein Mitglied ohne `admin` — der Normalfall unter den Eltern. */
const ALS_MITGLIED = false
/** Ein Zugang mit `admin`, der Personenbezogenes sehen darf. */
const ALS_ADMIN = true

beforeEach(() => {
	db = createTestDb()
	process.env.LIST_DOMAIN = 'klasse-beispiel.lists.example.org'
	upsertGroup({ key: 'elternvertretung', label: 'Elternvertretung' }, db)
	upsertGroup({ key: 'kollegium', label: 'Kollegium' }, db)
})

afterEach(() => {
	process.env = { ...original }
})

describe('verteilerUebersicht', () => {
	test('setzt die Adresse aus Localpart und Listen-Domain zusammen', () => {
		upsertMailingList(
			{ address: 'eltern', label: 'Eltern', recipient_groups: ['eltern'] },
			db,
		)
		expect(verteilerUebersicht(ALS_MITGLIED, db)[0]?.adresse).toBe(
			'eltern@klasse-beispiel.lists.example.org',
		)

		// Dieselbe Liste, andere Klasse: die Adresse muss mitwandern. Waere sie
		// irgendwo als Konstante hinterlegt, bliebe sie hier stehen — und genau
		// das war der Fehler, den diese Seite abloest.
		process.env.LIST_DOMAIN = 'ganz-andere-klasse.lists.example.net'
		expect(verteilerUebersicht(ALS_MITGLIED, db)[0]?.adresse).toBe(
			'eltern@ganz-andere-klasse.lists.example.net',
		)
	})

	test('ein Mitglied ohne admin sieht Adresse, Gruppen und Schreibrecht', () => {
		upsertMailingList(
			{
				address: 'eltern',
				label: 'Alle Eltern',
				recipient_groups: ['eltern'],
				poster_policy: 'eingeschraenkt',
				poster_groups: ['elternvertretung'],
				reply_mode: 'list',
				subject_prefix: '[Eltern]',
			},
			db,
		)
		const [v] = verteilerUebersicht(ALS_MITGLIED, db)
		expect(v).toMatchObject({
			adresse: 'eltern@klasse-beispiel.lists.example.org',
			label: 'Alle Eltern',
			empfaengerGruppen: ['Eltern'],
			antwortAn: 'list',
			betreffPraefix: '[Eltern]',
		})
		expect(v?.schreibrecht).toMatchObject({
			kind: 'eingeschraenkt',
			gruppen: ['Elternvertretung'],
		})
	})

	test('nennt Gruppen mit ihrem Label — keine Personen und keine Anzahl', () => {
		upsertMitglied(
			{
				id: 'anna',
				first_name: 'Anna',
				last_name: 'Beispiel',
				email: 'anna@example.org',
				groups: ['eltern'],
			},
			db,
		)
		upsertMailingList(
			{ address: 'eltern', label: 'Eltern', recipient_groups: ['eltern'] },
			db,
		)
		const roh = JSON.stringify(verteilerUebersicht(ALS_MITGLIED, db))
		expect(roh).toContain('Eltern')
		// Weder Name noch Adresse noch eine Zahl, aus der sich in einer Klasse
		// erraten liesse, wer gemeint ist.
		expect(roh).not.toContain('Anna')
		expect(roh).not.toContain('anna@example.org')
		expect(roh).not.toMatch(/\b1\b/)
	})

	test('macht sichtbar, wen eine Obergruppe stillschweigend einschliesst', () => {
		upsertGroup({ key: 'alle', label: 'Alle' }, db)
		addSubgroup('alle', 'kollegium', db)
		upsertMailingList(
			{ address: 'alle', label: 'Alle', recipient_groups: ['alle'] },
			db,
		)
		const [v] = verteilerUebersicht(ALS_MITGLIED, db)
		expect(v?.empfaengerGruppen).toEqual(['Alle'])
		expect(v?.weitereUeberUntergruppen).toEqual(['Kollegium'])
	})

	test('ein inaktiver Verteiler erscheint nicht', () => {
		upsertMailingList(
			{ address: 'aktiv', label: 'Aktiv', recipient_groups: ['eltern'] },
			db,
		)
		upsertMailingList(
			{
				address: 'stillgelegt',
				label: 'Stillgelegt',
				recipient_groups: ['eltern'],
				aktiv: false,
			},
			db,
		)
		expect(verteilerUebersicht(ALS_MITGLIED, db).map((v) => v.label)).toEqual([
			'Aktiv',
		])
	})

	test('offene Liste: das Schreibrecht wird als solches ausgewiesen', () => {
		upsertMailingList(
			{
				address: 'offen',
				label: 'Offen',
				recipient_groups: ['eltern'],
				poster_policy: 'offen',
			},
			db,
		)
		expect(verteilerUebersicht(ALS_MITGLIED, db)[0]?.schreibrecht).toEqual({
			kind: 'offen',
		})
	})

	describe('Absender-Muster', () => {
		beforeEach(() => {
			upsertMailingList(
				{
					address: 'info',
					label: 'Info',
					recipient_groups: ['eltern'],
					poster_policy: 'eingeschraenkt',
					sender_patterns: [
						'*@schule.example',
						'schulbuero@example.org',
						'hausmeister@example.org',
					],
				},
				db,
			)
		})

		test('ein Mitglied sieht Domain-Muster, aber keine Einzeladressen', () => {
			const s = verteilerUebersicht(ALS_MITGLIED, db)[0]?.schreibrecht
			expect(s).toMatchObject({
				kind: 'eingeschraenkt',
				muster: ['*@schule.example'],
				adressen: [],
				// Dass es weitere gibt, darf jeder wissen — nur nicht, welche.
				verborgeneAdressen: 2,
			})
			expect(JSON.stringify(s)).not.toContain('schulbuero')
			expect(JSON.stringify(s)).not.toContain('hausmeister')
		})

		test('mit der Faehigkeit personen stehen die Einzeladressen da', () => {
			expect(verteilerUebersicht(ALS_ADMIN, db)[0]?.schreibrecht).toMatchObject(
				{
					muster: ['*@schule.example'],
					adressen: ['schulbuero@example.org', 'hausmeister@example.org'],
					verborgeneAdressen: 0,
				},
			)
		})
	})
})

describe('Keine fest verdrahteten Adressen mehr', () => {
	/**
	 * Der eigentliche Fehler war nicht die falsche Adresse, sondern dass sie
	 * ueberhaupt im Text stand. Dieser Test bewacht die Ursache, nicht das
	 * Symptom: taucht irgendwo wieder eine Listen-Domain als Literal auf, faellt
	 * es hier auf und nicht erst, wenn jemand ins Leere antwortet.
	 */
	const projekt = process.cwd()

	const textDateien = (): string[] => {
		const treffer: string[] = []
		const lauf = (dir: string): void => {
			for (const eintrag of fs.readdirSync(dir, { withFileTypes: true })) {
				const voll = path.join(dir, eintrag.name)
				if (eintrag.isDirectory()) {
					lauf(voll)
				} else if (/\.(astro|md|mdx)$/.test(eintrag.name)) {
					treffer.push(voll)
				}
			}
		}
		lauf(path.join(projekt, 'src'))
		return treffer
	}

	test('in Seiten und Inhalten steht keine Verteiler-Adresse als Text', () => {
		// Adressen der Form <irgendwas>@<irgendwas>.lists.<domain> bzw. die
		// abgeloeste Mailman-Domain.
		const verdaechtig = /[\w.-]+@[\w.-]*lists\.[\w.-]+|lists\.klasse-[\w.-]+/i
		const fundstellen = textDateien()
			.map((datei) => ({
				datei: path.relative(projekt, datei),
				zeile: fs
					.readFileSync(datei, 'utf-8')
					.split('\n')
					.find((z) => verdaechtig.test(z)),
			}))
			.filter((f) => f.zeile !== undefined)
		expect(fundstellen).toEqual([])
	})
})
