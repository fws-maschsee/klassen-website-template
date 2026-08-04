import { describe, expect, test } from 'vitest'
import {
	computeSignature,
	MAX_SKEW_SECONDS,
	verifyListSignature,
} from '../../src/lib/lists/signature.js'

const SECRET = 'test-secret'
const BODY = Buffer.from('From: a@example.org\r\n\r\nHallo', 'utf-8')
const NOW = 1_800_000_000

const sign = (ts: number, body: Buffer = BODY) =>
	computeSignature(SECRET, `${ts}`, body)

describe('verifyListSignature', () => {
	test('akzeptiert eine korrekte, frische Signatur', () => {
		expect(
			verifyListSignature({
				secret: SECRET,
				timestamp: `${NOW}`,
				signature: sign(NOW),
				rawBody: BODY,
				nowSeconds: NOW,
			}),
		).toEqual({ ok: true })
	})

	test('lehnt einen veraenderten Body ab', () => {
		expect(
			verifyListSignature({
				secret: SECRET,
				timestamp: `${NOW}`,
				signature: sign(NOW),
				rawBody: Buffer.from('etwas anderes'),
				nowSeconds: NOW,
			}),
		).toMatchObject({ ok: false })
	})

	test('lehnt ein falsches Secret ab', () => {
		expect(
			verifyListSignature({
				secret: 'anderes-secret',
				timestamp: `${NOW}`,
				signature: sign(NOW),
				rawBody: BODY,
				nowSeconds: NOW,
			}),
		).toMatchObject({ ok: false })
	})

	test('lehnt eine alte Signatur ab (Replay-Schutz)', () => {
		const old = NOW - MAX_SKEW_SECONDS - 1
		expect(
			verifyListSignature({
				secret: SECRET,
				timestamp: `${old}`,
				signature: sign(old),
				rawBody: BODY,
				nowSeconds: NOW,
			}),
		).toMatchObject({ ok: false, reason: expect.stringContaining('Toleranz') })
	})

	test('lehnt ab, wenn gar kein Secret konfiguriert ist', () => {
		expect(
			verifyListSignature({
				secret: undefined,
				timestamp: `${NOW}`,
				signature: sign(NOW),
				rawBody: BODY,
				nowSeconds: NOW,
			}),
		).toMatchObject({ ok: false })
	})

	test('lehnt fehlende Header ab', () => {
		expect(
			verifyListSignature({
				secret: SECRET,
				timestamp: null,
				signature: null,
				rawBody: BODY,
				nowSeconds: NOW,
			}),
		).toMatchObject({ ok: false })
	})

	test('vertraegt eine Signatur falscher Laenge ohne zu werfen', () => {
		expect(
			verifyListSignature({
				secret: SECRET,
				timestamp: `${NOW}`,
				signature: 'ab',
				rawBody: BODY,
				nowSeconds: NOW,
			}),
		).toMatchObject({ ok: false })
	})
})
