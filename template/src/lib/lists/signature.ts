import { createHmac, timingSafeEqual } from 'node:crypto'

export const MAX_SKEW_SECONDS = 300

export const HEADER_CLASS = 'x-list-class'
export const HEADER_LIST_NAME = 'x-list-name'
export const HEADER_RECIPIENT = 'x-list-recipient'
export const HEADER_ENVELOPE_FROM = 'x-list-envelope-from'
export const HEADER_MESSAGE_ID = 'x-list-message-id'
export const HEADER_TIMESTAMP = 'x-list-timestamp'
export const HEADER_SIGNATURE = 'x-list-signature'

export const computeSignature = (
	secret: string,
	timestamp: string,
	rawBody: Buffer | string,
): string =>
	// Signatur statt Bearer-Token: bindet Inhalt und Zeitpunkt, ein abgefangener Request ist nicht wiederverwendbar.
	createHmac('sha256', secret)
		.update(`${timestamp}.`)
		.update(rawBody)
		.digest('hex')

export type VerifyResult = { ok: true } | { ok: false; reason: string }

export const verifyListSignature = (params: {
	secret: string | undefined
	timestamp: string | null
	signature: string | null
	rawBody: Buffer
	nowSeconds?: number
}): VerifyResult => {
	const { secret, timestamp, signature, rawBody } = params
	if (!secret) return { ok: false, reason: 'LIST_WEBHOOK_SECRET nicht gesetzt' }
	if (!timestamp || !signature) {
		return { ok: false, reason: 'Signatur-Header fehlen' }
	}
	const ts = Number.parseInt(timestamp, 10)
	if (!Number.isFinite(ts))
		return { ok: false, reason: 'ungueltiger Timestamp' }
	const now = params.nowSeconds ?? Math.floor(Date.now() / 1000)
	if (Math.abs(now - ts) > MAX_SKEW_SECONDS) {
		return { ok: false, reason: 'Timestamp ausserhalb der Toleranz' }
	}

	const expected = computeSignature(secret, timestamp, rawBody)
	const a = Buffer.from(expected, 'hex')
	const b = Buffer.from(signature, 'hex')
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		return { ok: false, reason: 'Signatur stimmt nicht' }
	}
	return { ok: true }
}
