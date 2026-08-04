import { describe, expect, test } from 'vitest'
import { headerSafe, smtpSafe } from '../src/app.js'

describe('headerSafe', () => {
	test('entfernt CR und LF (Header-Injection)', () => {
		expect(headerSafe('a@b.de\r\nX-Evil: 1')).toBe('a@b.deX-Evil: 1')
		expect(headerSafe('a@b.de\nX-Evil: 1')).toBe('a@b.deX-Evil: 1')
	})

	test('entfernt NUL und andere Steuerzeichen', () => {
		expect(headerSafe('a\u0000b\u0001c')).toBe('abc')
	})

	test('entfernt Nicht-ASCII', () => {
		expect(headerSafe('müller@example.org')).toBe('mller@example.org')
	})

	test('lässt normale Adressen unverändert', () => {
		expect(headerSafe('mutter@example.org')).toBe('mutter@example.org')
		expect(headerSafe('<abc.123@example.org>')).toBe('<abc.123@example.org>')
	})

	test('kürzt überlange Werte', () => {
		expect(headerSafe('a'.repeat(500))).toHaveLength(320)
	})
})

describe('smtpSafe', () => {
	test('schreibt Umlaute um, statt sie zu löschen', () => {
		expect(smtpSafe('Nachricht zu groß für die Liste')).toBe(
			'Nachricht zu gross fuer die Liste',
		)
		expect(smtpSafe('ÄÖÜ')).toBe('AeOeUe')
	})

	test('entfernt übriges Nicht-ASCII und Steuerzeichen', () => {
		expect(smtpSafe('abc\r\ndef')).toBe('abcdef')
		expect(smtpSafe('Grüße 😀')).toBe('Gruesse')
	})

	test('kürzt auf SMTP-verträgliche Länge', () => {
		expect(smtpSafe('a'.repeat(500))).toHaveLength(200)
	})
})
