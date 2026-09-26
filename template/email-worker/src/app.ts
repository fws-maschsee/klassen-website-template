import type { ParsedRecipient } from './address.js'
import type { Config } from './env.js'
import { computeSignature, currentTimestamp } from './signature.js'

export type Verdict =
	| { kind: 'accepted'; status: number }
	| { kind: 'rejected'; reason: string }

export class TemporaryFailure extends Error {}

export const headerSafe = (value: string, maxLength = 320): string =>
	value.replace(/[^ -~]/g, '').slice(0, maxLength)

// SMTP-Antworten sind ohne SMTPUTF8 reines ASCII; umschreiben statt löschen, Eltern lesen den Text.
const TRANSLITERATION: Record<string, string> = {
	ä: 'ae',
	ö: 'oe',
	ü: 'ue',
	Ä: 'Ae',
	Ö: 'Oe',
	Ü: 'Ue',
	ß: 'ss',
}

export const smtpSafe = (value: string, maxLength = 200): string =>
	value
		.replace(/[äöüÄÖÜß]/g, (character) => TRANSLITERATION[character])
		.replace(/[^ -~]/g, '')
		.trim()
		.slice(0, maxLength)

const rejectReason = (text: string, fallback: string): string =>
	smtpSafe(text) || smtpSafe(fallback)

const reasonOf = (body: string): string => {
	try {
		const parsed: unknown = JSON.parse(body)
		if (parsed && typeof parsed === 'object' && 'reason' in parsed) {
			const reason = (parsed as { reason: unknown }).reason
			if (typeof reason === 'string') return reason
		}
	} catch {
		// kein JSON: der Body selbst ist der Text
	}
	return body
}

export const deliver = async (
	config: Config,
	recipient: ParsedRecipient,
	envelopeFrom: string,
	messageId: string | null,
	raw: Uint8Array,
): Promise<Verdict> => {
	const timestamp = currentTimestamp()
	const signature = await computeSignature(config.secret, timestamp, raw)

	let response: Response
	try {
		response = await fetch(config.incomingUrl, {
			method: 'POST',
			// Metadaten nur in Headern: der Body bleibt byteweise die Originalmail, die die Signatur abdeckt.
			headers: {
				'Content-Type': 'message/rfc822',
				'X-List-Class': recipient.class,
				'X-List-Name': recipient.list,
				'X-List-Recipient': headerSafe(recipient.recipient),
				'X-List-Envelope-From': headerSafe(envelopeFrom),
				...(messageId ? { 'X-List-Message-Id': headerSafe(messageId) } : {}),
				'X-List-Timestamp': timestamp,
				'X-List-Signature': signature,
			},
			body: raw,
			signal: AbortSignal.timeout(config.requestTimeoutMs),
		})
	} catch (error) {
		throw new TemporaryFailure(
			`App nicht erreichbar (${config.incomingUrl}): ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	const body = await response.text().catch(() => '')
	if (response.ok) return { kind: 'accepted', status: response.status }
	if (
		response.status === 403 ||
		response.status === 404 ||
		response.status === 413
	) {
		return {
			kind: 'rejected',
			reason: rejectReason(reasonOf(body), 'Nachricht abgelehnt'),
		}
	}
	// Auch 401: eine falsche Signatur ist unser Konfigurationsfehler, nicht der des Absenders.
	throw new TemporaryFailure(
		`App antwortete ${response.status}: ${body.slice(0, 200)}`,
	)
}
