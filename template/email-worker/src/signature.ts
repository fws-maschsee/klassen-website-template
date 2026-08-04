/**
 * Signatur für die Aufrufe an die App (Stripe-Stil).
 *
 * Signiert wird `${timestamp}.` + rohe Body-Bytes per HMAC-SHA256, das Ergebnis
 * hex-kodiert. Der Timestamp geht in die Signatur ein, damit die App eine
 * abgefangene Anfrage nicht beliebig lange wiedereinspielen kann (Replay).
 *
 * Dieses Verfahren ist absichtlich identisch zu dem im Schwester-Projekt
 * `cdu-nordstemmen/vorstand` — die App-Seite (`verifyListSignature`) kann von
 * dort übernommen werden.
 */

const encoder = new TextEncoder()

const toHex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')

/** Fügt `${timestamp}.` vor den Body — ohne Zwischen-String, der Body ist binär. */
const prefixed = (timestamp: string, body: Uint8Array): Uint8Array => {
	const prefix = encoder.encode(`${timestamp}.`)
	const data = new Uint8Array(prefix.byteLength + body.byteLength)
	data.set(prefix, 0)
	data.set(body, prefix.byteLength)
	return data
}

export const computeSignature = async (
	secret: string,
	timestamp: string,
	body: Uint8Array,
): Promise<string> => {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		prefixed(timestamp, body),
	)
	return toHex(signature)
}

/** Aktueller Unix-Zeitstempel in Sekunden, als String für den Header. */
export const currentTimestamp = (): string =>
	Math.floor(Date.now() / 1000).toString()
