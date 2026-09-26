const encoder = new TextEncoder()

const toHex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')

const prefixed = (timestamp: string, body: Uint8Array): Uint8Array => {
	const prefix = encoder.encode(`${timestamp}.`)
	const data = new Uint8Array(prefix.byteLength + body.byteLength)
	data.set(prefix, 0)
	data.set(body, prefix.byteLength)
	return data
}

// Timestamp mitsigniert gegen Replay; das Format muss zu verifyListSignature in der App passen.
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

export const currentTimestamp = (): string =>
	Math.floor(Date.now() / 1000).toString()
