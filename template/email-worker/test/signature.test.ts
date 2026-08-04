import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { computeSignature } from '../src/signature.js'

const SECRET = 'test-secret'
const body = new TextEncoder().encode('rohe MIME-Bytes')

/**
 * Gegenstück auf App-Seite (Node-Crypto). Steht bewusst hier ausgeschrieben:
 * Wenn sich das Signaturformat im Worker ändert, muss dieser Test brechen —
 * sonst fällt es erst im Betrieb an einem 401 auf.
 */
const nodeSignature = (timestamp: string, data: Uint8Array): string =>
	createHmac('sha256', SECRET)
		.update(`${timestamp}.`)
		.update(data)
		.digest('hex')

describe('computeSignature', () => {
	test('stimmt mit der Node-Implementierung der App überein', async () => {
		expect(await computeSignature(SECRET, '1700000000', body)).toBe(
			nodeSignature('1700000000', body),
		)
	})

	test('ändert sich mit dem Timestamp (Replay-Schutz)', async () => {
		const a = await computeSignature(SECRET, '1700000000', body)
		const b = await computeSignature(SECRET, '1700000001', body)
		expect(a).not.toBe(b)
	})

	test('ändert sich mit dem Body', async () => {
		const a = await computeSignature(SECRET, '1700000000', body)
		const b = await computeSignature(
			SECRET,
			'1700000000',
			new TextEncoder().encode('andere Bytes'),
		)
		expect(a).not.toBe(b)
	})

	test('ändert sich mit dem Secret', async () => {
		const a = await computeSignature(SECRET, '1700000000', body)
		const b = await computeSignature('anderes-secret', '1700000000', body)
		expect(a).not.toBe(b)
	})

	test('liefert 64 Hex-Zeichen (SHA-256)', async () => {
		expect(await computeSignature(SECRET, '1700000000', body)).toMatch(
			/^[0-9a-f]{64}$/,
		)
	})
})
