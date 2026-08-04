import type { Database } from 'better-sqlite3'
import { openDb } from './index.js'
import type {
	ListAttachmentRow,
	ListMessageRow,
	ListOutboundRow,
} from './types.js'

export type IncomingAttachment = {
	filename: string | null
	content_type: string | null
	content: Buffer
}

export type EnqueueListMessageInput = {
	list_address: string
	from_email: string
	from_name: string | null
	subject: string
	body_html: string | null
	body_text: string | null
	original_message_id: string | null
	/**
	 * Schluessel gegen Doppelverteilung bei Worker-Retries. `null` = keine
	 * Garantie moeglich (Mail ohne Message-ID).
	 */
	idempotency_key: string | null
	attachments: IncomingAttachment[]
	/** Empfaenger als (email, mitglied_id?)-Paare. */
	recipients: { email: string; mitglied_id: string | null }[]
}

export type EnqueueListMessageResult = {
	message_id: number
	enqueued: number
	/** true, wenn die Mail schon einmal angenommen wurde (Retry des Workers). */
	duplicate: boolean
}

/** Findet eine bereits angenommene Mail anhand ihres Idempotenz-Schluessels. */
export const findListMessageByIdempotencyKey = (
	key: string,
	db: Database = openDb(),
): ListMessageRow | undefined =>
	db
		.prepare<[string], ListMessageRow>(
			'SELECT * FROM list_messages WHERE idempotency_key = ?',
		)
		.get(key)

/**
 * Speichert eine eingegangene Listen-Mail (Message + Anhaenge) und legt fuer
 * jeden Empfaenger eine `queued`-Zeile in `list_outbound` an — alles in EINER
 * Transaktion. Doppelte Empfaengeradressen werden dedupliziert.
 *
 * Idempotenz des Eingangs: Liegt `idempotency_key` bereits vor, wird NICHT
 * erneut verteilt, sondern die bestehende `message_id` zurueckgegeben. Der
 * Cloudflare-Worker darf dieselbe Mail also gefahrlos erneut zustellen (SMTP
 * ist at-least-once).
 */
export const enqueueListMessage = (
	input: EnqueueListMessageInput,
	db: Database = openDb(),
): EnqueueListMessageResult => {
	if (input.idempotency_key) {
		const existing = findListMessageByIdempotencyKey(input.idempotency_key, db)
		if (existing) {
			return { message_id: existing.id, enqueued: 0, duplicate: true }
		}
	}

	const tx = db.transaction((): EnqueueListMessageResult => {
		const messageId = Number(
			db
				.prepare<{
					list_address: string
					from_email: string
					from_name: string | null
					subject: string
					body_html: string | null
					body_text: string | null
					original_message_id: string | null
					idempotency_key: string | null
				}>(
					`INSERT INTO list_messages (
             list_address, from_email, from_name, subject,
             body_html, body_text, original_message_id, idempotency_key
           ) VALUES (
             @list_address, @from_email, @from_name, @subject,
             @body_html, @body_text, @original_message_id, @idempotency_key
           )`,
				)
				.run({
					list_address: input.list_address,
					from_email: input.from_email,
					from_name: input.from_name,
					subject: input.subject,
					body_html: input.body_html,
					body_text: input.body_text,
					original_message_id: input.original_message_id,
					idempotency_key: input.idempotency_key,
				}).lastInsertRowid,
		)

		const insAtt = db.prepare<[number, string | null, string | null, Buffer]>(
			'INSERT INTO list_attachments (message_id, filename, content_type, content) VALUES (?, ?, ?, ?)',
		)
		for (const att of input.attachments) {
			insAtt.run(messageId, att.filename, att.content_type, att.content)
		}

		const insOut = db.prepare<[number, string, string | null]>(
			'INSERT INTO list_outbound (message_id, recipient_email, mitglied_id) VALUES (?, ?, ?)',
		)
		const seen = new Set<string>()
		let enqueued = 0
		for (const r of input.recipients) {
			const key = r.email.trim().toLowerCase()
			if (!key || seen.has(key)) continue
			seen.add(key)
			insOut.run(messageId, r.email, r.mitglied_id)
			enqueued++
		}
		return { message_id: messageId, enqueued, duplicate: false }
	})
	return tx()
}

export const getListMessage = (
	id: number,
	db: Database = openDb(),
): ListMessageRow | undefined =>
	db
		.prepare<[number], ListMessageRow>(
			'SELECT * FROM list_messages WHERE id = ?',
		)
		.get(id)

export const getListAttachments = (
	messageId: number,
	db: Database = openDb(),
): ListAttachmentRow[] =>
	db
		.prepare<[number], ListAttachmentRow>(
			'SELECT * FROM list_attachments WHERE message_id = ? ORDER BY id',
		)
		.all(messageId)

/** Aelteste queued-Outbound-Eintraege (aelteste zuerst). */
export const peekListOutbound = (
	limit: number,
	db: Database = openDb(),
): ListOutboundRow[] =>
	db
		.prepare<[number], ListOutboundRow>(
			"SELECT * FROM list_outbound WHERE status = 'queued' ORDER BY id ASC LIMIT ?",
		)
		.all(limit)

/** Atomar `queued` -> `sending`. Nur der Gewinner (changes === 1) verarbeitet. */
export const claimListOutbound = (
	id: number,
	db: Database = openDb(),
): boolean =>
	db
		.prepare<[number]>(
			"UPDATE list_outbound SET status = 'sending', claimed_at = datetime('now') WHERE id = ? AND status = 'queued'",
		)
		.run(id).changes === 1

export const completeListOutbound = (
	id: number,
	patch: {
		status: 'sent' | 'error'
		sent_message_id?: string | null
		error_message?: string | null
	},
	db: Database = openDb(),
): void => {
	db.prepare<{
		id: number
		status: string
		sent_message_id: string | null
		error_message: string | null
	}>(
		`UPDATE list_outbound
        SET status = @status,
            sent_message_id = @sent_message_id,
            error_message = @error_message,
            sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @id`,
	).run({
		id,
		status: patch.status,
		sent_message_id: patch.sent_message_id ?? null,
		error_message: patch.error_message ?? null,
	})
}

export const listOutboundForMessage = (
	messageId: number,
	db: Database = openDb(),
): ListOutboundRow[] =>
	db
		.prepare<[number], ListOutboundRow>(
			'SELECT * FROM list_outbound WHERE message_id = ? ORDER BY id',
		)
		.all(messageId)

export const countListSentInLastHour = (db: Database = openDb()): number =>
	db
		.prepare<[], { c: number }>(
			"SELECT COUNT(*) AS c FROM list_outbound WHERE status = 'sent' AND sent_at >= datetime('now', '-1 hour')",
		)
		.get()?.c ?? 0

export const countListQueued = (db: Database = openDb()): number =>
	db
		.prepare<[], { c: number }>(
			"SELECT COUNT(*) AS c FROM list_outbound WHERE status = 'queued'",
		)
		.get()?.c ?? 0

/**
 * Reboot-/Stuck-Cleanup analog zu email_send_log: haengende `sending`-Eintraege
 * (aelter als `maxAgeSeconds`, oder alle bei `maxAgeSeconds <= 0`) auf `error`.
 */
export const cleanupStuckListOutbound = (
	db: Database = openDb(),
	maxAgeSeconds = 0,
): number =>
	maxAgeSeconds <= 0
		? db
				.prepare<[string]>(
					`UPDATE list_outbound
              SET status = 'error',
                  error_message = COALESCE(error_message, ?),
                  sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE status = 'sending'`,
				)
				.run(
					'Worker-Neustart hat den Versand unterbrochen - bitte erneut senden',
				).changes
		: db
				.prepare<[string, string]>(
					`UPDATE list_outbound
              SET status = 'error',
                  error_message = COALESCE(error_message, ?),
                  sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE status = 'sending'
              AND (claimed_at IS NULL OR claimed_at < datetime('now', ?))`,
				)
				.run(
					`Versand-Timeout (>${maxAgeSeconds}s in sending)`,
					`-${maxAgeSeconds} seconds`,
				).changes
