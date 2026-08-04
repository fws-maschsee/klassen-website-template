import { describe, expect, test } from 'vitest'
import { parseListRecipient } from '../src/address.js'

const DOMAIN = 'lists.example.org'
const KLASSE = 'klasse-musterfrau'

const parse = (address: string) => parseListRecipient(address, DOMAIN, KLASSE)

const abgelehnt: Array<[string, string]> = [
	['fremde Domain', 'eltern@boese.example'],
	['Listen-Domain ohne Klassen-Label', 'eltern@lists.example.org'],
	[
		'tiefer verschachtelte Subdomain',
		'eltern@a.klasse-musterfrau.lists.example.org',
	],
	['Domain, die nur zufällig so endet', 'eltern@boeselists.example.org'],
	[
		'Steuerzeichen im Localpart (Header-Injection)',
		'eltern\r\nX-Evil: 1@klasse-musterfrau.lists.example.org',
	],
	['Punkt im Klassen-Label', 'eltern@klasse.musterfrau.lists.example.org'],
	[
		'Unterstrich im Klassen-Label',
		'eltern@klasse_musterfrau.lists.example.org',
	],
	[
		'Pfadtrenner im Klassen-Label',
		'eltern@klasse/musterfrau.lists.example.org',
	],
	[
		'führender Bindestrich im Klassen-Label',
		'eltern@-musterfrau.lists.example.org',
	],
	['Adresse ohne @', 'eltern.klasse-musterfrau'],
	['leerer Listenname', '@klasse-musterfrau.lists.example.org'],
	[
		'überlanger Localpart',
		`${'a'.repeat(65)}@klasse-musterfrau.lists.example.org`,
	],
	['leere Adresse', ''],
	[
		'zweites @ im Localpart',
		'eltern+@klasse-fremd@klasse-musterfrau.lists.example.org',
	],
]

describe('parseListRecipient', () => {
	test('zerlegt eine reguläre Listenadresse', () => {
		expect(parse('eltern@klasse-musterfrau.lists.example.org')).toEqual({
			ok: true,
			value: {
				list: 'eltern',
				class: 'klasse-musterfrau',
				recipient: 'eltern@klasse-musterfrau.lists.example.org',
				tag: null,
			},
		})
	})

	test('erkennt eine beliebige, nicht fest verdrahtete Liste', () => {
		const result = parse('lehrer@klasse-musterfrau.lists.example.org')
		expect(result.ok && result.value.list).toBe('lehrer')
	})

	test('normalisiert Groß-/Kleinschreibung und Leerzeichen', () => {
		const result = parse('  Eltern@Klasse-Musterfrau.Lists.Example.Org ')
		expect(result.ok && result.value).toMatchObject({
			list: 'eltern',
			class: 'klasse-musterfrau',
			recipient: 'eltern@klasse-musterfrau.lists.example.org',
		})
	})

	test('schneidet die Plus-Adressierung vom Listennamen ab', () => {
		const result = parse('eltern+2026@klasse-musterfrau.lists.example.org')
		expect(result.ok && result.value.list).toBe('eltern')
		expect(result.ok && result.value.tag).toBe('2026')
	})

	test.each(abgelehnt)('lehnt ab: %s', (_name, address) => {
		expect(parse(address).ok).toBe(false)
	})
})

describe('parseListRecipient — fremde Klasse', () => {
	test('lehnt die Adresse einer anderen Klasse ab', () => {
		const result = parse('eltern@klasse-nachbar.lists.example.org')
		expect(result.ok).toBe(false)
		expect(!result.ok && result.reason).toContain('klasse-nachbar')
	})

	test('lehnt auch ein Klassen-Label ab, das nur ähnlich aussieht', () => {
		for (const fremd of [
			'eltern@klasse-musterfrau2.lists.example.org',
			'eltern@klasse-musterfra.lists.example.org',
			'eltern@xklasse-musterfrau.lists.example.org',
		]) {
			expect(parse(fremd).ok).toBe(false)
		}
	})

	test('greift für jede Liste, nicht nur für eltern@', () => {
		expect(parse('lehrer@klasse-nachbar.lists.example.org').ok).toBe(false)
	})

	test('lässt sich nicht durch Großschreibung umgehen', () => {
		expect(parse('eltern@KLASSE-NACHBAR.lists.example.org').ok).toBe(false)
	})

	test('derselbe Parser nimmt die Adresse für die eigene Klasse an', () => {
		expect(
			parseListRecipient(
				'eltern@klasse-nachbar.lists.example.org',
				DOMAIN,
				'klasse-nachbar',
			).ok,
		).toBe(true)
	})
})
