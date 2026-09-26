import type { Database } from 'better-sqlite3'
import { simpleParser } from 'mailparser'
import { enqueueListMessage } from '../db/listQueue.js'
import {
	getMailingList,
	isSenderAllowed,
	normalizeEmail,
	resolveListRecipients,
} from '../db/mailingLists.js'

export type IncomingResult =
	| {
			kind: 'enqueued'
			message_id: number
			recipients: number
			duplicate: boolean
	  }
	| { kind: 'skipped'; reason: string }
	| { kind: 'unknown_list'; reason: string }
	| { kind: 'rejected'; reason: string }

export const statusForResult = (result: IncomingResult): number => {
	switch (result.kind) {
		case 'enqueued':
			return 202
		case 'skipped':
			return 200
		case 'unknown_list':
			return 404
		case 'rejected':
			return 403
	}
}

const headerString = (
	headers: Map<string, unknown>,
	key: string,
): string | undefined => {
	const v = headers.get(key)
	if (typeof v === 'string') return v.toLowerCase()
	if (v && typeof v === 'object' && 'value' in v) {
		const val = (v as { value: unknown }).value
		if (typeof val === 'string') return val.toLowerCase()
	}
	return undefined
}

export type SenderCheck =
	| { allowed: true; list: string; label: string; recipients: number }
	| { allowed: false; reason: string; list?: string }

export const checkListSender = (
	listAddress: string,
	fromEmail: string,
	db?: Database,
): SenderCheck => {
	const list = getMailingList(listAddress, db)
	if (!list)
		return { allowed: false, reason: `Unbekannte Liste "${listAddress}".` }
	if (list.aktiv !== 1) {
		return {
			allowed: false,
			reason: `Die Liste "${listAddress}" ist derzeit deaktiviert.`,
			list: list.address,
		}
	}
	if (!isSenderAllowed(list, fromEmail, db)) {
		return {
			allowed: false,
			reason: `Diese Absenderadresse ist nicht berechtigt, an die Liste "${listAddress}" zu schreiben.`,
			list: list.address,
		}
	}
	return {
		allowed: true,
		list: list.address,
		label: list.label,
		recipients: resolveListRecipients(list, db).length,
	}
}

export type IncomingParams = {
	listName: string
	envelopeFrom: string
	messageId?: string | null
}

export const handleIncomingListMail = async (
	rawBody: Buffer,
	params: IncomingParams,
	db?: Database,
): Promise<IncomingResult> => {
	const { listName, envelopeFrom } = params

	const list = getMailingList(listName, db)
	if (!list) {
		return {
			kind: 'unknown_list',
			reason: `Es gibt keine Liste "${listName}".`,
		}
	}
	if (list.aktiv !== 1) {
		return {
			kind: 'rejected',
			reason: `Die Liste "${listName}" ist derzeit deaktiviert.`,
		}
	}

	if (!envelopeFrom.trim()) {
		return { kind: 'rejected', reason: 'Die Nachricht hat keinen Absender.' }
	}
	if (!isSenderAllowed(list, envelopeFrom, db)) {
		return {
			kind: 'rejected',
			reason: `Diese Absenderadresse ist nicht berechtigt, an die Liste "${listName}" zu schreiben.`,
		}
	}

	const parsed = await simpleParser(rawBody)

	const listHeader = parsed.headers.get('list') as { id?: unknown } | undefined
	if (listHeader?.id) {
		return {
			kind: 'skipped',
			reason: 'Ist bereits eine Listenmail (List-Id gesetzt).',
		}
	}
	const autoSubmitted = headerString(parsed.headers, 'auto-submitted')
	if (autoSubmitted && autoSubmitted !== 'no') {
		return {
			kind: 'skipped',
			reason: `Automatische Antwort: ${autoSubmitted}.`,
		}
	}
	const precedence = headerString(parsed.headers, 'precedence')
	if (precedence === 'list' || precedence === 'bulk' || precedence === 'junk') {
		return {
			kind: 'skipped',
			reason: `Massenmail (Precedence: ${precedence}).`,
		}
	}

	const recipients = resolveListRecipients(list, db).map((r) => ({
		email: r.email,
		mitglied_id: r.mitglied_id,
	}))
	if (recipients.length === 0) {
		return {
			kind: 'skipped',
			reason: 'Die Liste hat derzeit keine Empfänger.',
		}
	}

	const headerFrom = parsed.from?.value?.[0]
	const fromName = headerFrom?.name?.trim() || null
	const html = typeof parsed.html === 'string' ? parsed.html : null
	const text = typeof parsed.text === 'string' ? parsed.text : null
	const messageId = params.messageId ?? parsed.messageId ?? null

	const { message_id, enqueued, duplicate } = enqueueListMessage(
		{
			list_address: list.address,
			from_email: normalizeEmail(envelopeFrom),
			from_name: fromName,
			subject: parsed.subject ?? '',
			body_html: html,
			body_text: text,
			original_message_id: messageId,
			idempotency_key: messageId ? `${list.address}|${messageId}` : null,
			attachments: parsed.attachments.map((a) => ({
				filename: a.filename ?? null,
				content_type: a.contentType ?? null,
				content: a.content,
			})),
			recipients,
		},
		db,
	)

	return { kind: 'enqueued', message_id, recipients: enqueued, duplicate }
}
