import type {
	ListAttachmentRow,
	ListMessageRow,
	MailingListRow,
} from '../db/types.js'
import { listDomain, listEnvelopeFrom, mailReplyTo } from '../email/config.js'
import type { SendInput } from '../email/transport.js'

/** Vollstaendige Adresse einer Liste, z.B. `eltern@example.org`. */
export const listAddressFull = (list: MailingListRow): string =>
	`${list.address}@${listDomain()}`

const sanitizeDisplay = (value: string): string =>
	value.replace(/["\r\n]+/g, ' ').trim()

/**
 * Der `From:`-Header der weiterverteilten Mail zeigt auf die LISTE, nicht auf
 * die Privatadresse des Absenders. Das ist nicht nur Hoeflichkeit: SES
 * signiert nur fuer die eigene verifizierte Domain, und eine fremde
 * From-Domain wuerde an DMARC scheitern. Der Originalabsender bleibt im
 * Display-Namen ("Anna Beispiel via Eltern") und im `X-Original-From`-Header
 * sichtbar.
 */
export const buildListFrom = (
	message: ListMessageRow,
	list: MailingListRow,
): string => {
	const origin = sanitizeDisplay(message.from_name || message.from_email)
	const display = sanitizeDisplay(`${origin} via ${list.label}`)
	return `"${display}" <${listAddressFull(list)}>`
}

export const applySubjectPrefix = (
	subject: string,
	prefix: string | null,
): string => {
	if (!prefix) return subject
	const trimmed = prefix.trim()
	if (!trimmed) return subject
	return subject.includes(trimmed) ? subject : `${trimmed} ${subject}`
}

/**
 * Baut die auszuliefernde Mail fuer EINEN Empfaenger. Inhalt und Anhaenge
 * bleiben unveraendert; ergaenzt werden nur die Listen-Header, damit
 * Mailprogramme die Nachricht als Listenmail erkennen und Mailfilter sie nicht
 * fuer eine Spoofing-Mail halten.
 */
export const buildListSendInput = (
	message: ListMessageRow,
	attachments: ListAttachmentRow[],
	list: MailingListRow,
	recipientEmail: string,
): SendInput => {
	const full = listAddressFull(list)
	const envelopeFrom = listEnvelopeFrom()
	const replyTo = list.reply_mode === 'list' ? full : message.from_email
	const unsubscribeContact = mailReplyTo()
	const unsubscribeSubject = encodeURIComponent(`Austragen ${list.address}`)

	return {
		from: buildListFrom(message, list),
		to: recipientEmail,
		replyTo,
		sender: envelopeFrom,
		envelope: { from: envelopeFrom, to: recipientEmail },
		subject: applySubjectPrefix(message.subject, list.subject_prefix),
		html: message.body_html ?? '',
		text: message.body_text ?? message.body_html ?? '',
		attachments: attachments.map((a) => ({
			filename: a.filename ?? 'anhang',
			content: a.content,
			...(a.content_type ? { contentType: a.content_type } : {}),
		})),
		headers: {
			'List-Id': `${list.label} <${list.address}.${listDomain()}>`,
			'List-Unsubscribe': `<mailto:${unsubscribeContact}?subject=${unsubscribeSubject}>`,
			'List-Post': list.reply_mode === 'list' ? `<mailto:${full}>` : 'NO',
			Precedence: 'list',
			'X-Original-From': message.from_name
				? `${sanitizeDisplay(message.from_name)} <${message.from_email}>`
				: message.from_email,
		},
	}
}
