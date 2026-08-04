import path from 'node:path'
import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { upsertEmailMeta } from '../../src/lib/db/emails.js'
import { upsertMitglied } from '../../src/lib/db/members.js'
import {
	countByStatus,
	listSendLog,
	requeueErrors,
} from '../../src/lib/db/sendLog.js'
import { suppressAddress } from '../../src/lib/db/suppressions.js'
import {
	enqueueEmailToRecipients,
	processBatch,
} from '../../src/lib/email/queue.js'
import type { SendInput } from '../../src/lib/email/transport.js'
import { createTestDb } from '../helpers/db.js'

/**
 * Die Idempotenz des Versands ist die teuerste Stelle im System: Ein Fehler
 * hier bedeutet, dass 25 Elternhaeuser dieselbe Mail zweimal (oder zehnmal)
 * bekommen. Getestet wird der komplette Weg Einreihen -> Worker -> Log.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

const EMAILS_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'emails')
const SLUG = '2026-08-01-testmail'

let db: Database
let sent: SendInput[]

const okTransport = {
	send: async (input: SendInput) => {
		sent.push(input)
		return { messageId: `<msg-${sent.length}@example.org>` }
	},
}

const failingTransport = {
	send: async () => {
		throw new Error('SES sagt nein')
	},
}

const enqueue = (force = false) =>
	enqueueEmailToRecipients(SLUG, { db, force, emailsDir: EMAILS_DIR })

/** Arbeitet die Queue vollstaendig ab. */
const drain = async (transport: {
	send: (i: SendInput) => Promise<{ messageId: string }>
}) => {
	for (;;) {
		const batch = await processBatch({ db, transport, emailsDir: EMAILS_DIR })
		if (batch.kind !== 'batch_done') return batch
	}
}

beforeEach(() => {
	db = createTestDb()
	sent = []
	upsertEmailMeta(
		{ slug: SLUG, subject: 'Testmail', sender: null, recipients_kind: 'group' },
		db,
	)
	for (const [id, email] of [
		['anna', 'anna@example.org'],
		['bert', 'bert@example.org'],
	] as const) {
		upsertMitglied(
			{
				id,
				first_name: id,
				last_name: 'Beispiel',
				email,
				groups: ['eltern'],
			},
			db,
		)
	}
})

describe('Einreihen', () => {
	test('reiht jeden Empfaenger genau einmal ein', async () => {
		expect(await enqueue()).toMatchObject({ enqueued: 2 })
		expect(countByStatus(SLUG, db).queued).toBe(2)
	})

	test('ein zweiter Aufruf reiht NICHTS zusaetzlich ein', async () => {
		await enqueue()
		const second = await enqueue()
		expect(second.enqueued).toBe(0)
		expect(second.skipped_already_queued).toBe(2)
		expect(countByStatus(SLUG, db).queued).toBe(2)
	})

	test('nach erfolgreichem Versand wird nicht erneut eingereiht', async () => {
		await enqueue()
		await drain(okTransport)
		expect(sent).toHaveLength(2)

		const second = await enqueue()
		expect(second.enqueued).toBe(0)
		expect(second.skipped_already_sent).toBe(2)

		await drain(okTransport)
		expect(sent).toHaveLength(2)
	})

	test('force schickt bewusst erneut', async () => {
		await enqueue()
		await drain(okTransport)
		expect(await enqueue(true)).toMatchObject({ enqueued: 2 })
		await drain(okTransport)
		expect(sent).toHaveLength(4)
	})

	test('Personen ohne E-Mail-Adresse werden uebersprungen, nicht als Fehler gezaehlt', async () => {
		upsertMitglied(
			{
				id: 'ohne',
				first_name: 'Otto',
				last_name: 'Beispiel',
				groups: ['eltern'],
			},
			db,
		)
		const result = await enqueue()
		expect(result.enqueued).toBe(2)
		expect(result.skipped_no_email).toBe(1)
	})

	test('global gesperrte Adressen werden nicht eingereiht', async () => {
		suppressAddress(
			{ email: 'bert@example.org', source: 'bounce', bounce_type: 'Permanent' },
			db,
		)
		const result = await enqueue()
		expect(result.enqueued).toBe(1)
		expect(result.skipped_suppressed).toBe(1)

		await drain(okTransport)
		expect(sent.map((m) => m.to)).toEqual(['anna@example.org'])
	})

	test('skip-Flag verhindert das Einreihen komplett', async () => {
		upsertEmailMeta(
			{
				slug: '2026-08-02-gestoppt',
				subject: 'Nicht senden',
				sender: null,
				recipients_kind: 'group',
			},
			db,
		)
		const result = await enqueueEmailToRecipients('2026-08-02-gestoppt', {
			db,
			emailsDir: EMAILS_DIR,
		})
		expect(result.enqueued).toBe(0)
		expect(listSendLog('2026-08-02-gestoppt', db)).toEqual([])
	})
})

describe('Worker', () => {
	test('personalisiert Betreff und Text pro Empfaenger', async () => {
		await enqueue()
		await drain(okTransport)
		expect(sent.map((m) => m.subject).sort()).toEqual([
			'Testmail fuer anna',
			'Testmail fuer bert',
		])
		expect(sent[0]?.html).toContain('Hallo')
		expect(sent[0]?.text.length).toBeGreaterThan(0)
	})

	test('ein zweiter Claim derselben Zeile sendet nicht noch einmal', async () => {
		await enqueue()
		// Erster Durchlauf leert die Queue vollstaendig.
		await drain(okTransport)
		// Ein weiterer Durchlauf findet nichts mehr.
		expect(
			await processBatch({ db, transport: okTransport, emailsDir: EMAILS_DIR }),
		).toMatchObject({ kind: 'queue_empty' })
		expect(sent).toHaveLength(2)
	})

	test('parallele Batches senden jede Zeile nur einmal', async () => {
		await enqueue()
		// Zwei Batches gleichzeitig: der atomare Claim entscheidet, wer sendet.
		await Promise.all([
			drain(okTransport),
			drain(okTransport),
			drain(okTransport),
		])
		expect(sent).toHaveLength(2)
		expect(countByStatus(SLUG, db).sent).toBe(2)
	})

	test('Fehler landen als error und blockieren die Queue nicht', async () => {
		await enqueue()
		await drain(failingTransport)
		const counts = countByStatus(SLUG, db)
		expect(counts.error).toBe(2)
		expect(counts.queued).toBe(0)
	})
})

describe('Nachbesserung', () => {
	test('retry reicht nur die Fehlgeschlagenen nach', async () => {
		await enqueue()
		await drain(failingTransport)

		expect(requeueErrors(SLUG, db)).toBe(2)
		await drain(okTransport)
		expect(sent).toHaveLength(2)
		// Die alten Fehlerzeilen bleiben als Historie stehen, gezaehlt wird der
		// jeweils LETZTE Status pro Person.
		expect(countByStatus(SLUG, db)).toMatchObject({ sent: 2, error: 0 })
		expect(listSendLog(SLUG, db).length).toBe(4)
	})

	test('retry fasst erfolgreich Belieferte nicht an', async () => {
		await enqueue()
		await drain(okTransport)
		expect(requeueErrors(SLUG, db)).toBe(0)
	})
})
