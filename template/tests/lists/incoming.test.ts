import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { upsertGroup } from '../../src/lib/db/groups.js'
import { upsertMailingList } from '../../src/lib/db/mailingLists.js'
import { upsertMitglied } from '../../src/lib/db/members.js'
import type { SendInput } from '../../src/lib/email/transport.js'
import {
	checkListSender,
	handleIncomingListMail,
	statusForResult,
} from '../../src/lib/lists/incoming.js'
import { processListBatch } from '../../src/lib/lists/queue.js'
import { createTestDb } from '../helpers/db.js'

/**
 * Der Weg vom Cloudflare-Worker bis zum SMTP-Aufruf: rohe Mail rein,
 * n Zustellungen raus. Der Vertrag mit dem Worker steht in
 * `email-worker/README.md`.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

let db: Database
let sent: SendInput[]

const transport = {
	send: async (input: SendInput) => {
		sent.push(input)
		return { messageId: `<out-${sent.length}@example.org>` }
	},
}

const rawMail = (headers: Record<string, string>, body = 'Inhalt'): Buffer => {
	const head = Object.entries(headers)
		.map(([k, v]) => `${k}: ${v}`)
		.join('\r\n')
	return Buffer.from(`${head}\r\n\r\n${body}`, 'utf-8')
}

type DeliverOptions = {
	/** Envelope-Absender (SMTP MAIL FROM). Darauf wird autorisiert. */
	envelopeFrom?: string
	/** From:-Header im Body. Frei wählbar, für die Berechtigung irrelevant. */
	headerFrom?: string
	messageId?: string
	subject?: string
	listName?: string
	/** Zusätzliche Roh-Header der Mail (List-Id, Auto-Submitted, …). */
	extraHeaders?: Record<string, string>
}

/**
 * Stellt eine Mail so zu, wie der Worker es tut: Listenname, Envelope-Absender
 * und Message-ID kommen als Parameter (beim Worker als `X-List-*`-Header),
 * NICHT aus dem Body.
 */
const deliver = async (options: DeliverOptions = {}) => {
	const envelopeFrom = options.envelopeFrom ?? 'vera@example.org'
	const headers: Record<string, string> = {
		Subject: options.subject ?? 'Betreff',
		From: options.headerFrom ?? envelopeFrom,
		...(options.messageId ? { 'Message-ID': options.messageId } : {}),
		...options.extraHeaders,
	}
	const result = await handleIncomingListMail(
		rawMail(headers),
		{
			listName: options.listName ?? 'eltern',
			envelopeFrom,
			messageId: options.messageId ?? null,
		},
		db,
	)
	for (;;) {
		const batch = await processListBatch({ db, transport })
		if (batch.kind !== 'batch_done') break
	}
	return result
}

beforeEach(() => {
	db = createTestDb()
	sent = []
	upsertGroup({ key: 'elternvertretung', label: 'Elternvertretung' }, db)
	upsertMitglied(
		{
			id: 'vertreterin',
			first_name: 'Vera',
			last_name: 'Beispiel',
			email: 'vera@example.org',
			groups: ['eltern', 'elternvertretung'],
		},
		db,
	)
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
		{
			address: 'eltern',
			label: 'Eltern',
			recipient_groups: ['eltern'],
			poster_groups: ['elternvertretung'],

			poster_policy: 'eingeschraenkt',
			subject_prefix: '[Eltern]',
		},
		db,
	)
})

describe('Annahme und Verteilung', () => {
	test('verteilt an alle Empfaenger, mit Prefix und umgeschriebenem From', async () => {
		const result = await deliver({
			headerFrom: 'Vera Beispiel <vera@example.org>',
			subject: 'Termin',
			messageId: '<a1@example.org>',
		})

		expect(result.kind).toBe('enqueued')
		expect(statusForResult(result)).toBe(202)
		expect(sent).toHaveLength(2)
		expect(sent.map((m) => m.to).sort()).toEqual([
			'anna@example.org',
			'vera@example.org',
		])
		expect(sent[0]?.subject).toBe('[Eltern] Termin')
		// From zeigt auf die Liste (DMARC), der Originalabsender bleibt sichtbar.
		expect(sent[0]?.from).toContain('Vera Beispiel via Eltern')
		expect(sent[0]?.from).toContain('eltern@')
		expect(sent[0]?.headers?.['X-Original-From']).toContain('vera@example.org')
		expect(sent[0]?.headers?.Precedence).toBe('list')
		expect(sent[0]?.headers?.['List-Id']).toContain('eltern.')
	})

	test('reply_mode sender laesst Antworten an den Absender gehen', async () => {
		await deliver({ messageId: '<a2@example.org>' })
		expect(sent[0]?.replyTo).toBe('vera@example.org')
	})

	test('reply_mode list laesst Antworten an die Liste gehen', async () => {
		upsertMailingList(
			{
				address: 'eltern',
				label: 'Eltern',
				recipient_groups: ['eltern'],
				poster_groups: ['elternvertretung'],

				poster_policy: 'eingeschraenkt',
				reply_mode: 'list',
			},
			db,
		)
		await deliver({ messageId: '<a3@example.org>' })
		expect(sent[0]?.replyTo).toContain('eltern@')
	})

	test('Prefix wird nicht doppelt gesetzt', async () => {
		await deliver({
			subject: '[Eltern] Re: Termin',
			messageId: '<a4@example.org>',
		})
		expect(sent[0]?.subject).toBe('[Eltern] Re: Termin')
	})
})

describe('Berechtigung', () => {
	test('autorisiert wird der Envelope-Absender, nicht der From-Header', async () => {
		// Unberechtigter Envelope-Absender, der sich im Body als berechtigte
		// Person ausgibt. Genau der Angriff, gegen den der Worker den
		// Envelope-Absender getrennt mitschickt.
		const result = await deliver({
			envelopeFrom: 'fremd@example.org',
			headerFrom: 'Vera Beispiel <vera@example.org>',
			messageId: '<spoof@example.org>',
		})
		expect(result).toMatchObject({ kind: 'rejected' })
		expect(sent).toHaveLength(0)
	})

	test('berechtigter Envelope-Absender kommt durch, auch bei abweichendem From', async () => {
		const result = await deliver({
			envelopeFrom: 'vera@example.org',
			headerFrom: 'Vera privat <vera-privat@example.org>',
			messageId: '<abweichend@example.org>',
		})
		expect(result.kind).toBe('enqueued')
		expect(sent).toHaveLength(2)
	})

	test('unberechtigter Absender wird abgelehnt und nichts verschickt', async () => {
		const result = await deliver({
			envelopeFrom: 'anna@example.org',
			messageId: '<b1@example.org>',
		})
		expect(result).toMatchObject({ kind: 'rejected' })
		expect(statusForResult(result)).toBe(403)
		expect(sent).toHaveLength(0)
	})

	test('unbekannte Liste ergibt 404, nicht 403', async () => {
		const result = await deliver({ listName: 'gibtsnicht' })
		expect(result).toMatchObject({ kind: 'unknown_list' })
		expect(statusForResult(result)).toBe(404)
	})

	test('deaktivierte Liste wird abgelehnt', async () => {
		upsertMailingList(
			{
				address: 'eltern',
				label: 'Eltern',
				recipient_groups: ['eltern'],
				poster_groups: ['elternvertretung'],

				poster_policy: 'eingeschraenkt',
				aktiv: false,
			},
			db,
		)
		const result = await deliver()
		expect(result).toMatchObject({ kind: 'rejected' })
		expect(statusForResult(result)).toBe(403)
	})

	test('leerer Envelope-Absender wird abgelehnt', async () => {
		const result = await deliver({ envelopeFrom: '' })
		expect(result).toMatchObject({ kind: 'rejected' })
	})

	test('Ablehnungsgruende nennen keine Empfaengeradressen', async () => {
		const result = await deliver({ envelopeFrom: 'anna@example.org' })
		if (result.kind !== 'rejected') throw new Error('erwartet: rejected')
		// Der Text geht als Unzustellbarkeitsnachricht an den Absender.
		expect(result.reason).not.toContain('vera@example.org')
		expect(result.reason).toContain('eltern')
	})
})

describe('Schleifenschutz (angenommen, aber nicht verteilt)', () => {
	test('bereits gelistete Mail wird nicht erneut verteilt', async () => {
		const result = await deliver({
			extraHeaders: {
				'List-Id': 'Eltern <eltern.klasse-musterfrau.lists.example.org>',
			},
		})
		expect(result).toMatchObject({ kind: 'skipped' })
		expect(statusForResult(result)).toBe(200)
		expect(sent).toHaveLength(0)
	})

	test('Abwesenheitsnotiz wird nicht verteilt', async () => {
		const result = await deliver({
			extraHeaders: { 'Auto-Submitted': 'auto-replied' },
		})
		expect(result).toMatchObject({ kind: 'skipped' })
		expect(sent).toHaveLength(0)
	})

	test('Massenmail-Precedence wird nicht verteilt', async () => {
		const result = await deliver({ extraHeaders: { Precedence: 'bulk' } })
		expect(result).toMatchObject({ kind: 'skipped' })
	})
})

describe('Idempotenz des Eingangs', () => {
	test('zweite Zustellung derselben Mail verteilt nicht erneut', async () => {
		const first = await deliver({ messageId: '<einmalig@example.org>' })
		const second = await deliver({ messageId: '<einmalig@example.org>' })

		expect(first).toMatchObject({ kind: 'enqueued', duplicate: false })
		expect(second).toMatchObject({
			kind: 'enqueued',
			duplicate: true,
			recipients: 0,
		})
		expect(sent).toHaveLength(2)
	})

	test('ohne Message-ID gibt es keine Idempotenz-Garantie', async () => {
		await deliver()
		await deliver()
		expect(sent).toHaveLength(4)
	})

	test('dieselbe Message-ID auf einer anderen Liste ist keine Wiederholung', async () => {
		upsertMailingList(
			{
				address: 'info',
				label: 'Info',
				recipient_groups: ['eltern'],
				poster_groups: ['elternvertretung'],

				poster_policy: 'eingeschraenkt',
			},
			db,
		)
		await deliver({ messageId: '<gleich@example.org>' })
		const second = await deliver({
			messageId: '<gleich@example.org>',
			listName: 'info',
		})
		expect(second).toMatchObject({ kind: 'enqueued', duplicate: false })
		expect(sent).toHaveLength(4)
	})
})

describe('checkListSender (optionale Vorabpruefung)', () => {
	test('erlaubt berechtigte Absender und nennt die Empfaengerzahl', () => {
		expect(checkListSender('eltern', 'VERA@example.org', db)).toMatchObject({
			allowed: true,
			list: 'eltern',
			recipients: 2,
		})
	})

	test('lehnt unberechtigte Absender ab', () => {
		expect(checkListSender('eltern', 'anna@example.org', db)).toMatchObject({
			allowed: false,
		})
	})

	test('lehnt unbekannte Listen ab', () => {
		expect(checkListSender('gibtsnicht', 'vera@example.org', db)).toMatchObject(
			{
				allowed: false,
			},
		)
	})
})
