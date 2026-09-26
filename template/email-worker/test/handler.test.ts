import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Env } from '../src/env.js'
import { handleEmail, type IncomingMessage } from '../src/index.js'
import { computeSignature } from '../src/signature.js'

const env: Env = {
	APP_BASE_URL: 'https://klasse-musterfrau.example.org',
	LIST_DOMAIN: 'lists.example.org',
	CLASS_SLUG: 'klasse-musterfrau',
	LIST_WEBHOOK_SECRET: 'test-secret',
}

const URL_INCOMING = 'https://klasse-musterfrau.example.org/api/lists/incoming'

const RAW = [
	'From: Mutter <mutter@example.org>',
	'To: eltern@klasse-musterfrau.lists.example.org',
	'Subject: Elternabend',
	'Message-ID: <abc@example.org>',
	'',
	'Hallo zusammen',
].join('\r\n')

type TestMessage = IncomingMessage & { rejects: string[] }

const createMessage = (
	options: {
		to?: string
		from?: string
		headers?: Record<string, string>
		raw?: string
		rawSize?: number
	} = {},
): TestMessage => {
	const bytes = new TextEncoder().encode(options.raw ?? RAW)
	const rejects: string[] = []
	return {
		from: options.from ?? 'mutter@example.org',
		to: options.to ?? 'eltern@klasse-musterfrau.lists.example.org',
		headers: new Headers({
			from: 'Mutter <mutter@example.org>',
			'message-id': '<abc@example.org>',
			...options.headers,
		}),
		raw: new Blob([bytes]).stream(),
		rawSize: options.rawSize ?? bytes.byteLength,
		setReject: (reason: string) => {
			rejects.push(reason)
		},
		rejects,
	}
}

type Call = { url: string; init: RequestInit }

const stubFetch = (responses: Array<Response | Error>): { calls: Call[] } => {
	const calls: Call[] = []
	let index = 0
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		calls.push({ url, init })
		const next = responses[index++]
		if (next === undefined) throw new Error(`unerwarteter fetch auf ${url}`)
		if (next instanceof Error) throw next
		return next
	})
	return { calls }
}

const ok = (status = 202) => new Response('{}', { status })
const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status })

const headerOf = (call: Call, name: string): string | undefined =>
	(call.init.headers as Record<string, string>)[name]

const bodyOf = (call: Call): string =>
	new TextDecoder().decode(call.init.body as Uint8Array)

beforeEach(() => {
	vi.unstubAllGlobals()
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('handleEmail — Zustellung', () => {
	test('postet an den Webhook der App', async () => {
		const { calls } = stubFetch([ok()])

		await handleEmail(createMessage(), env)

		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe(URL_INCOMING)
	})

	test('kommt auch mit einem Schrägstrich am Ende von APP_BASE_URL klar', async () => {
		const { calls } = stubFetch([ok()])

		await handleEmail(createMessage(), {
			...env,
			APP_BASE_URL: 'https://klasse-musterfrau.example.org/',
		})

		expect(calls[0].url).toBe(URL_INCOMING)
	})

	test('überträgt die Mail unverändert und byteweise', async () => {
		const { calls } = stubFetch([ok()])

		await handleEmail(createMessage(), env)

		expect(bodyOf(calls[0])).toBe(RAW)
		expect(headerOf(calls[0], 'Content-Type')).toBe('message/rfc822')
	})

	test('schickt Klasse, Liste, Empfänger und Message-ID als Header mit', async () => {
		const { calls } = stubFetch([ok()])

		await handleEmail(createMessage(), env)

		expect(headerOf(calls[0], 'X-List-Class')).toBe('klasse-musterfrau')
		expect(headerOf(calls[0], 'X-List-Name')).toBe('eltern')
		expect(headerOf(calls[0], 'X-List-Recipient')).toBe(
			'eltern@klasse-musterfrau.lists.example.org',
		)
		expect(headerOf(calls[0], 'X-List-Message-Id')).toBe('<abc@example.org>')
	})

	test('meldet den Envelope-Absender, nicht den From-Header', async () => {
		const { calls } = stubFetch([ok()])
		const message = createMessage({
			from: 'spammer@boese.example',
			headers: { from: 'Frau Musterfrau <lehrerin@example.org>' },
		})

		await handleEmail(message, env)

		expect(headerOf(calls[0], 'X-List-Envelope-From')).toBe(
			'spammer@boese.example',
		)
	})

	test('signiert die rohen Body-Bytes', async () => {
		const { calls } = stubFetch([ok()])

		await handleEmail(createMessage(), env)

		const timestamp = headerOf(calls[0], 'X-List-Timestamp') as string
		expect(timestamp).toMatch(/^\d+$/)
		expect(headerOf(calls[0], 'X-List-Signature')).toBe(
			await computeSignature(
				env.LIST_WEBHOOK_SECRET,
				timestamp,
				calls[0].init.body as Uint8Array,
			),
		)
	})

	test('akzeptiert 200 („angenommen, aber nicht verteilt“) ohne Ablehnung', async () => {
		stubFetch([ok(200)])
		const message = createMessage()

		await handleEmail(message, env)

		expect(message.rejects).toEqual([])
	})
})

describe('handleEmail — fremde Klasse', () => {
	test('reicht Post für eine andere Klasse NICHT an die eigene App weiter', async () => {
		const { calls } = stubFetch([])
		const message = createMessage({
			to: 'eltern@klasse-nachbar.lists.example.org',
		})

		await handleEmail(message, env)

		expect(calls).toHaveLength(0)
		expect(message.rejects).toHaveLength(1)
		expect(message.rejects[0]).toContain('klasse-nachbar')
	})

	test('derselbe Code bedient mit anderem CLASS_SLUG die andere Klasse', async () => {
		const { calls } = stubFetch([ok()])
		const message = createMessage({
			to: 'eltern@klasse-nachbar.lists.example.org',
		})

		await handleEmail(message, {
			...env,
			APP_BASE_URL: 'https://klasse-nachbar.example.org',
			CLASS_SLUG: 'klasse-nachbar',
		})

		expect(message.rejects).toEqual([])
		expect(calls[0].url).toBe(
			'https://klasse-nachbar.example.org/api/lists/incoming',
		)
	})
})

describe('handleEmail — Ablehnung (dauerhafter SMTP-Fehler)', () => {
	test('403: Absender nicht berechtigt', async () => {
		stubFetch([json(403, { reason: 'Absender nicht in der Klassenliste' })])
		const message = createMessage()

		await handleEmail(message, env)

		expect(message.rejects).toEqual(['Absender nicht in der Klassenliste'])
	})

	test('404: Liste unbekannt', async () => {
		stubFetch([json(404, { reason: 'Liste eltern unbekannt' })])
		const message = createMessage()

		await handleEmail(message, env)

		expect(message.rejects).toEqual(['Liste eltern unbekannt'])
	})

	test('413: eigenes Größenlimit der App', async () => {
		stubFetch([json(413, { reason: 'Anhang zu gross' })])
		const message = createMessage()

		await handleEmail(message, env)

		expect(message.rejects).toEqual(['Anhang zu gross'])
	})

	test('nimmt eine Ablehnung auch als Klartext-Body entgegen', async () => {
		stubFetch([new Response('kein Mitglied dieser Klasse', { status: 403 })])
		const message = createMessage()

		await handleEmail(message, env)

		expect(message.rejects).toEqual(['kein Mitglied dieser Klasse'])
	})

	test('nutzt einen Standardgrund, wenn die App keinen liefert', async () => {
		stubFetch([new Response('', { status: 403 })])
		const message = createMessage()

		await handleEmail(message, env)

		expect(message.rejects).toEqual(['Nachricht abgelehnt'])
	})

	test('schreibt Umlaute im Reject-Grund um (SMTP ist ASCII)', async () => {
		stubFetch([json(403, { reason: 'Nachricht zu groß für die Liste' })])
		const message = createMessage()

		await handleEmail(message, env)

		expect(message.rejects).toEqual(['Nachricht zu gross fuer die Liste'])
	})

	test('lehnt eine Adresse außerhalb des Schemas ab, ohne die App zu fragen', async () => {
		const { calls } = stubFetch([])
		const message = createMessage({ to: 'eltern@boese.example' })

		await handleEmail(message, env)

		expect(message.rejects).toHaveLength(1)
		expect(message.rejects[0]).toContain('Unbekannte Listenadresse')
		expect(calls).toHaveLength(0)
	})

	test('lehnt eine zu große Mail ab, ohne sie hochzuladen', async () => {
		const { calls } = stubFetch([])
		const message = createMessage({ rawSize: 11 * 1024 * 1024 })

		await handleEmail(message, env)

		expect(message.rejects[0]).toContain('zu gross')
		expect(calls).toHaveLength(0)
	})

	test('respektiert ein konfiguriertes Größenlimit', async () => {
		stubFetch([])
		const message = createMessage({ rawSize: 2048 })

		await handleEmail(message, { ...env, MAX_MESSAGE_BYTES: '1024' })

		expect(message.rejects).toHaveLength(1)
	})
})

describe('handleEmail — temporärer Fehler (Mail bleibt beim Absender)', () => {
	const expectTemporary = async (message: TestMessage, override?: Env) => {
		await expect(handleEmail(message, override ?? env)).rejects.toThrow()
		expect(message.rejects).toEqual([])
	}

	test('App antwortet mit 500', async () => {
		stubFetch([new Response('boom', { status: 500 })])
		await expectTemporary(createMessage())
	})

	test('App antwortet mit 502', async () => {
		stubFetch([new Response('bad gateway', { status: 502 })])
		await expectTemporary(createMessage())
	})

	test('App ist nicht erreichbar', async () => {
		stubFetch([new TypeError('fetch failed')])
		await expectTemporary(createMessage())
	})

	test('401: Signatur passt nicht — unser Konfigurationsfehler, nicht der des Absenders', async () => {
		stubFetch([new Response('unauthorized', { status: 401 })])
		await expectTemporary(createMessage())
	})

	test('fehlendes Secret führt nicht zu einer Ablehnung', async () => {
		const { calls } = stubFetch([])
		const message = createMessage()

		await expectTemporary(message, { ...env, LIST_WEBHOOK_SECRET: '' })

		expect(calls).toHaveLength(0)
	})

	test('fehlendes CLASS_SLUG führt nicht zu einer Ablehnung', async () => {
		const { calls } = stubFetch([])
		const message = createMessage()

		await expectTemporary(message, { ...env, CLASS_SLUG: '' })

		expect(calls).toHaveLength(0)
	})

	test('unbrauchbares CLASS_SLUG führt nicht zu einer Ablehnung', async () => {
		stubFetch([])
		await expectTemporary(createMessage(), {
			...env,
			CLASS_SLUG: 'Klasse Musterfrau',
		})
	})

	test('APP_BASE_URL ohne https führt nicht zu einer Ablehnung', async () => {
		stubFetch([])
		await expectTemporary(createMessage(), {
			...env,
			APP_BASE_URL: 'http://klasse-musterfrau.example.org',
		})
	})

	test('kaputte APP_BASE_URL führt nicht zu einer Ablehnung', async () => {
		stubFetch([])
		await expectTemporary(createMessage(), {
			...env,
			APP_BASE_URL: 'nicht-mal-eine-url',
		})
	})
})

describe('handleEmail — Header-Injection', () => {
	test('entfernt Steuerzeichen aus dem Envelope-Absender', async () => {
		const { calls } = stubFetch([ok()])
		const message = createMessage({
			from: 'boese@example.org\r\nX-List-Class: andere-klasse',
		})

		await handleEmail(message, env)

		expect(headerOf(calls[0], 'X-List-Envelope-From')).toBe(
			'boese@example.orgX-List-Class: andere-klasse',
		)
		expect(headerOf(calls[0], 'X-List-Class')).toBe('klasse-musterfrau')
	})
})
