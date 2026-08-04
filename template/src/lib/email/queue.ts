import type { Database } from 'better-sqlite3'
import { openDb } from '../db/index.js'
import { getMitglied } from '../db/members.js'
import {
	claimQueued,
	completeQueued,
	countSentInLastHour,
	oldestSentInLastHour,
	peekQueued,
	recordSend,
} from '../db/sendLog.js'
import { globallySuppressedAddresses } from '../db/suppressions.js'
import type { SendLogRow } from '../db/types.js'
import { loadEmail } from '../emails/loader.js'
import { isEmailRecipient, resolveRecipients } from '../emails/recipients.js'
import { mailFrom, mailFromName, mailReplyTo } from './config.js'
import { renderForRecipient } from './render.js'
import type { EmailTransport } from './transport.js'
import { sesTransport } from './transport.js'

/**
 * Versand-Engine fuer Rundmails. Zwei Phasen, bewusst getrennt:
 *
 *   1. ENQUEUE (`enqueueEmailToRecipients`) — loest die Empfaenger auf und
 *      schreibt je Empfaenger eine `queued`-Zeile. HIER sitzt die Idempotenz:
 *      Wer fuer diesen Slug bereits eine `sent`-Zeile hat, wird uebersprungen;
 *      wer bereits eine `queued`-Zeile hat, wird nicht doppelt eingereiht.
 *   2. WORKER (`processBatch`) — arbeitet die Queue ab. Jeder Eintrag wird
 *      atomar geclaimt (`queued -> sending`), sodass parallele Batches
 *      denselben Eintrag nicht zweimal versenden.
 *
 * Der Rundmail-Weg kennt keine Listenadresse und beruecksichtigt daher nur die
 * GLOBALEN Adress-Sperren (`address_suppressions` mit `list_address = '*'`) —
 * das sind genau die harten Bounces und Beschwerden.
 */

const DEFAULT_HOURLY_CAP = 250
const DEFAULT_PARALLEL_BURST = 25

const hourlyCap = (): number =>
	Number.parseInt(process.env.MAIL_HOURLY_CAP ?? `${DEFAULT_HOURLY_CAP}`, 10)

const parallelBurst = (): number =>
	Number.parseInt(
		process.env.MAIL_PARALLEL_BURST ?? `${DEFAULT_PARALLEL_BURST}`,
		10,
	)

const buildFromHeader = (override: string | undefined): string =>
	override ?? `"${mailFromName()}" <${mailFrom()}>`

const buildReplyTo = (override: string | undefined): string =>
	override ?? mailReplyTo()

export type EnqueueOptions = {
	/** Auch an Empfaenger schicken, die bereits eine `sent`-Zeile haben. */
	force?: boolean
	db?: Database
	/** Verzeichnis der Rundmail-Dateien (Tests). */
	emailsDir?: string
}

export type EnqueueResult = {
	/** Anzahl neu in die Queue geschriebener Eintraege. */
	enqueued: number
	/** Bereits erfolgreich versendet und ohne `force` uebersprungen. */
	skipped_already_sent: number
	/** Standen bereits als `queued` in der Warteschlange. */
	skipped_already_queued: number
	/** Kein Eintrag mit E-Mail-Adresse. */
	skipped_no_email: number
	/** Adresse ist global gesperrt (Bounce/Beschwerde). */
	skipped_suppressed: number
}

export const enqueueEmailToRecipients = async (
	slug: string,
	options: EnqueueOptions = {},
): Promise<EnqueueResult> => {
	const db = options.db ?? openDb()
	const email = await loadEmail(slug, options.emailsDir)

	const result: EnqueueResult = {
		enqueued: 0,
		skipped_already_sent: 0,
		skipped_already_queued: 0,
		skipped_no_email: 0,
		skipped_suppressed: 0,
	}

	// Harte Stopps: `skip` deaktiviert den Versand, `sentExternally` markiert
	// eine Mail, die ausserhalb dieses Systems raus ist. In beiden Faellen wird
	// nichts eingereiht — unabhaengig vom Send-Log.
	if (email.skip || email.sentExternally) return result

	const recipients = resolveRecipients(email.recipients, db)

	const alreadySent = options.force
		? new Set<string>()
		: new Set(
				db
					.prepare<[string], { mitglied_id: string }>(
						"SELECT DISTINCT mitglied_id FROM email_send_log WHERE email_slug = ? AND status = 'sent'",
					)
					.all(slug)
					.map((r) => r.mitglied_id),
			)

	// Auch bereits eingereihte Eintraege vermeiden — sonst laege dieselbe Mail
	// nach einem zweiten `send_email`-Aufruf zweimal in der Queue.
	const alreadyQueued = new Set(
		db
			.prepare<[string], { mitglied_id: string }>(
				"SELECT DISTINCT mitglied_id FROM email_send_log WHERE email_slug = ? AND status IN ('queued', 'sending')",
			)
			.all(slug)
			.map((r) => r.mitglied_id),
	)

	const suppressed = globallySuppressedAddresses(db)

	const tx = db.transaction(() => {
		for (const mitglied of recipients) {
			if (alreadyQueued.has(mitglied.id)) {
				result.skipped_already_queued++
				continue
			}
			if (alreadySent.has(mitglied.id)) {
				result.skipped_already_sent++
				continue
			}
			if (!isEmailRecipient(mitglied)) {
				result.skipped_no_email++
				continue
			}
			if (suppressed.has((mitglied.email as string).trim().toLowerCase())) {
				recordSend(
					{
						email_slug: slug,
						mitglied_id: mitglied.id,
						status: 'skipped',
						error_message: 'Adresse gesperrt (Bounce/Beschwerde)',
					},
					db,
				)
				result.skipped_suppressed++
				continue
			}
			recordSend(
				{ email_slug: slug, mitglied_id: mitglied.id, status: 'queued' },
				db,
			)
			result.enqueued++
		}
	})
	tx()

	return result
}

export type ProcessOptions = {
	transport?: EmailTransport
	db?: Database
	emailsDir?: string
}

export type ProcessOneResult =
	| { kind: 'sent'; queueId: number; mitgliedId: string; messageId: string }
	| { kind: 'error'; queueId: number; mitgliedId: string; error: string }
	| { kind: 'claim_lost'; queueId: number; mitgliedId: string }

/**
 * Verarbeitet genau eine bereits gepickte `queued`-Zeile. Wirft NICHT — alle
 * Fehler landen als `error`-Result und als `error`-Zeile im Log.
 */
export const processOne = async (
	queued: SendLogRow,
	db: Database,
	transport: EmailTransport,
	emailsDir?: string,
): Promise<ProcessOneResult> => {
	// Atomarer Claim. Verhindert Doppelverarbeitung bei parallelen Batches.
	if (!claimQueued(queued.id, db)) {
		return {
			kind: 'claim_lost',
			queueId: queued.id,
			mitgliedId: queued.mitglied_id,
		}
	}

	const fail = (error: string): ProcessOneResult => {
		completeQueued(queued.id, { status: 'error', error_message: error }, db)
		return {
			kind: 'error',
			queueId: queued.id,
			mitgliedId: queued.mitglied_id,
			error,
		}
	}

	const mitglied = getMitglied(queued.mitglied_id, db)
	if (!mitglied) return fail('Adressbuch-Eintrag nicht gefunden')
	if (!mitglied.email) return fail('keine E-Mail-Adresse hinterlegt')

	try {
		const email = await loadEmail(queued.email_slug, emailsDir)
		const rendered = await renderForRecipient(email, mitglied)
		const { messageId } = await transport.send({
			from: buildFromHeader(email.from),
			to: mitglied.email,
			replyTo: buildReplyTo(email.replyTo),
			subject: rendered.subject,
			html: rendered.html,
			text: rendered.text,
		})
		completeQueued(queued.id, { status: 'sent', message_id: messageId }, db)
		return {
			kind: 'sent',
			queueId: queued.id,
			mitgliedId: queued.mitglied_id,
			messageId,
		}
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err))
	}
}

export type ProcessBatchResult =
	| { kind: 'cap_reached'; sentInLastHour: number; waitUntil: string }
	| { kind: 'queue_empty' }
	| {
			kind: 'batch_done'
			count: number
			results: PromiseSettledResult<ProcessOneResult>[]
	  }

/**
 * Verarbeitet einen Burst queued-Eintraege parallel. Stoppt frueh, wenn das
 * Stunden-Cap erreicht ist (SES drosselt sonst selbst und wirft Fehler) oder
 * die Queue leer ist.
 */
export const processBatch = async (
	options: ProcessOptions = {},
): Promise<ProcessBatchResult> => {
	const db = options.db ?? openDb()
	const transport = options.transport ?? sesTransport()

	const cap = hourlyCap()
	const sent = countSentInLastHour(db)
	if (sent >= cap) {
		const oldest = oldestSentInLastHour(db)
		const waitUntil = oldest
			? new Date(new Date(oldest).getTime() + 60 * 60 * 1000).toISOString()
			: new Date(Date.now() + 60 * 60 * 1000).toISOString()
		return { kind: 'cap_reached', sentInLastHour: sent, waitUntil }
	}

	const batchSize = Math.min(parallelBurst(), cap - sent)
	const queued = peekQueued(batchSize, db)
	if (queued.length === 0) return { kind: 'queue_empty' }

	const results = await Promise.allSettled(
		queued.map((q) => processOne(q, db, transport, options.emailsDir)),
	)
	return { kind: 'batch_done', count: queued.length, results }
}
