import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	type APIRequestContext,
	test as base,
	expect,
	type Page,
} from '@playwright/test'

/**
 * Gemeinsames Werkzeug der Autorisierungs-Tests.
 *
 * Alles hier spricht mit dem lokalen Stack aus `stack.mjs` — einem echten
 * ZITADEL in einem Container, das mit diesem Testlauf entsteht und mit ihm
 * vergeht. Kein Dienst im Netz, kein Nachbau, keine Zugangsdaten aus dem
 * Betrieb.
 */

const here = dirname(fileURLToPath(import.meta.url))
const statePath = resolve(here, '.stack/stack.json')

export type StackUser = {
	key: string
	userId: string
	email: string
	password: string
	/** ID des User-Grants im eigenen bzw. im Nachbarprojekt. */
	grantId?: string
}

export type Stack = {
	issuer: string
	loginBaseUri: string
	appOrigin: string
	/** PAT des Dienstnutzers DIESER Wegwerf-Instanz. Sonst nichts. */
	adminToken: string
	ownProjectId: string
	otherProjectId: string
	clientId: string
	clientSecret: string
	users: Record<string, StackUser>
}

export const readStack = (): Stack => {
	if (!existsSync(statePath)) {
		throw new Error(
			`Der Teststack laeuft nicht (${statePath} fehlt).\n` +
				'Vorher `npm run authz:up` ausfuehren — das startet PostgreSQL, ZITADEL,\n' +
				'die Anmeldeoberflaeche und diese Anwendung lokal.',
		)
	}
	return JSON.parse(readFileSync(statePath, 'utf8'))
}

// --- ZITADEL-Verwaltung waehrend des Tests ---------------------------------

/**
 * Die Handvoll ZITADEL-Aufrufe, die die Tests selbst brauchen: eine Rolle
 * vergeben, eine entziehen.
 *
 * Sie laufen gegen die lokale Instanz und veraendern deren Zustand — das ist
 * der Punkt. Genau dieser Schritt waere gegen einen produktiven
 * Verzeichnisdienst nicht verantwortbar: ein abgebrochener Lauf liesse dort
 * einen echten Zugang entzogen zurueck.
 */
export class Zitadel {
	constructor(
		private readonly stack: Stack,
		private readonly request: APIRequestContext,
	) {}

	private async call(
		method: 'post' | 'put' | 'delete',
		path: string,
		data?: unknown,
	) {
		const response = await this.request.fetch(`${this.stack.issuer}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.stack.adminToken}`,
				'Content-Type': 'application/json',
			},
			data: data === undefined ? undefined : JSON.stringify(data),
		})
		expect(
			response.ok(),
			`ZITADEL ${method.toUpperCase()} ${path}: ${response.status()} ${await response.text()}`,
		).toBe(true)
		const text = await response.text()
		return text ? JSON.parse(text) : {}
	}

	/** Setzt die Rollen eines bestehenden Grants neu. */
	setGrantRoles(user: StackUser, roles: string[]) {
		return this.call(
			'put',
			`/management/v1/users/${user.userId}/grants/${user.grantId}`,
			{ roleKeys: roles },
		)
	}

	/** Entzieht den Grant vollstaendig. */
	removeGrant(user: StackUser) {
		return this.call(
			'delete',
			`/management/v1/users/${user.userId}/grants/${user.grantId}`,
		)
	}

	/** Liest die Rollen, die ZITADEL fuer diesen Grant fuehrt. */
	async rolesOf(user: StackUser): Promise<string[]> {
		const result = await this.call(
			'post',
			'/management/v1/users/grants/_search',
			{
				queries: [{ userIdQuery: { userId: user.userId } }],
			},
		)
		const grant = (result.result ?? []).find(
			(row: { id: string }) => row.id === user.grantId,
		)
		return grant?.roleKeys ?? []
	}
}

// --- Anmeldung im Browser --------------------------------------------------

/**
 * Meldet sich ueber die ECHTE Anmeldeoberflaeche an — Login v2, dieselbe wie
 * im Betrieb.
 *
 * Bewusst kein abgekuerzter Weg (Cookie setzen, Token unterschieben): der
 * Anmeldevorgang IST der Teil, in dem die Rollen ins Spiel kommen, und ein
 * untergeschobenes Cookie haette genau den Fehler nicht gezeigt, um den es
 * hier geht — dass ein frisch ausgestelltes Token die Rollen aus einer alten
 * Sitzung erbt statt sie neu zu erfragen.
 */
export const signIn = async (
	page: Page,
	stack: Stack,
	user: StackUser,
	options: { startAt?: string } = {},
): Promise<void> => {
	await page.goto(options.startAt ?? '/')

	// Schritt 1: Kennung.
	//
	// Gewartet wird auf die Adresse der KENNUNGS-Seite und nicht nur auf
	// „irgendwo in Login v2". Der Weg dorthin geht ueber mehrere Stationen
	// (Anwendung -> ZITADEL -> /login -> /loginname), und waehrend Login v2
	// clientseitig umschaltet, stehen kurz die Felder BEIDER Seiten im
	// Dokument. Ein Zugriff in genau diesem Moment findet zwei Treffer und
	// scheitert — beobachtet, nicht befuerchtet. `toHaveCount(1)` wartet
	// deshalb ab, bis nur noch eine Seite da ist.
	await page.waitForURL(/\/ui\/v2\/login\/loginname/, { timeout: 30_000 })
	const loginName = page.locator('input[name="loginName"]')
	await expect(loginName).toHaveCount(1)
	await loginName.fill(user.email)
	// `data-testid` statt Beschriftung: die Oberflaeche kommt in mehreren
	// Sprachen, die Kennzeichnung ist stabil. Die Login-Version ist in
	// stack.mjs festgenagelt, damit das auch so bleibt.
	await page.getByTestId('submit-button').click()

	// Schritt 2: Kennwort.
	await page.waitForURL(/\/ui\/v2\/login\/password/, { timeout: 30_000 })
	const password = page.locator('input[type="password"]')
	await expect(password).toHaveCount(1)
	await password.fill(user.password)
	await page.getByTestId('submit-button').click()

	// Zurueck auf der Anwendung. Welche Antwort sie gibt (Inhalt oder „noch
	// nicht freigeschaltet"), entscheiden die einzelnen Tests — hier zaehlt
	// nur, dass der Anmeldevorgang durch ist.
	await page.waitForURL((url) => url.origin === stack.appOrigin, {
		timeout: 60_000,
	})
}

// --- MCP -------------------------------------------------------------------

const base64url = (input: Buffer): string => input.toString('base64url')

export type McpToken = {
	accessToken: string
	clientId: string
	clientSecret: string
}

/**
 * Verbindet einen MCP-Client so, wie ein echter es tut: dynamische
 * Registrierung, Authorization Code mit PKCE, Zustimmung im Browser,
 * Token-Tausch.
 *
 * Der Browser bringt dabei die bestehende Sitzung der Website mit — genau der
 * Weg, auf dem ein frisch ausgestelltes Token seine Rollen aus einer alten
 * Sitzung erben kann statt sie bei ZITADEL zu erfragen.
 */
export const connectMcpClient = async (
	page: Page,
	stack: Stack,
): Promise<McpToken> => {
	const redirectUri = `${stack.appOrigin}/e2e/mcp-callback`

	const registration = await page.request.post(`${stack.appOrigin}/register`, {
		data: {
			client_name: `E2E MCP Client ${randomBytes(4).toString('hex')}`,
			redirect_uris: [redirectUri],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'client_secret_post',
			scope: 'mcp',
		},
	})
	expect(
		registration.ok(),
		`Registrierung des MCP-Clients: ${registration.status()} ${await registration.text()}`,
	).toBe(true)
	const client = await registration.json()

	const verifier = base64url(randomBytes(32))
	const challenge = base64url(createHash('sha256').update(verifier).digest())
	const state = base64url(randomBytes(8))

	const authorize = new URL(`${stack.appOrigin}/authorize`)
	authorize.searchParams.set('client_id', client.client_id)
	authorize.searchParams.set('response_type', 'code')
	authorize.searchParams.set('redirect_uri', redirectUri)
	authorize.searchParams.set('code_challenge', challenge)
	authorize.searchParams.set('code_challenge_method', 'S256')
	authorize.searchParams.set('state', state)
	authorize.searchParams.set('scope', 'mcp')

	await page.goto(authorize.toString())
	await page.getByRole('button', { name: 'Autorisieren' }).click()
	await page.waitForURL(/\/e2e\/mcp-callback/, { timeout: 30_000 })

	const code = new URL(page.url()).searchParams.get('code')
	expect(code, 'Zustimmungsseite hat keinen Code geliefert').toBeTruthy()

	const token = await page.request.post(`${stack.appOrigin}/token`, {
		form: {
			grant_type: 'authorization_code',
			code: code as string,
			redirect_uri: redirectUri,
			code_verifier: verifier,
			client_id: client.client_id,
			client_secret: client.client_secret,
		},
	})
	expect(
		token.ok(),
		`Token-Tausch: ${token.status()} ${await token.text()}`,
	).toBe(true)
	const tokens = await token.json()

	return {
		accessToken: tokens.access_token,
		clientId: client.client_id,
		clientSecret: client.client_secret,
	}
}

export type McpResult = {
	status: number
	/** `true`, wenn das Werkzeug den Aufruf abgelehnt hat. */
	isError: boolean
	text: string
}

/**
 * Ruft ein MCP-Werkzeug auf. Der Streamable-HTTP-Transport antwortet als
 * Server-Sent-Events; die Nutzlast steht in den `data:`-Zeilen.
 */
export const callMcpTool = async (
	request: APIRequestContext,
	stack: Stack,
	accessToken: string,
	name: string,
	args: Record<string, unknown>,
): Promise<McpResult> => {
	const response = await request.post(`${stack.appOrigin}/mcp`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json, text/event-stream',
			'Content-Type': 'application/json',
		},
		data: {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name, arguments: args },
		},
	})

	const body = await response.text()
	if (!response.ok()) {
		return { status: response.status(), isError: true, text: body }
	}

	const payload = body
		.split('\n')
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trim())
		.join('')
	const parsed = JSON.parse(payload || body)
	const result = parsed.result ?? {}
	const text = (result.content ?? [])
		.map((part: { text?: string }) => part.text ?? '')
		.join('\n')
	return {
		status: response.status(),
		isError: Boolean(result.isError) || Boolean(parsed.error),
		text: text || JSON.stringify(parsed),
	}
}

// --- Fixtures --------------------------------------------------------------

export const test = base.extend<{ stack: Stack; zitadel: Zitadel }>({
	// Playwright wertet die Destrukturierung des ersten Parameters aus, um zu
	// erkennen, welche Fixtures diese hier braucht — naemlich keine. Ein
	// benannter Parameter statt `{}` wird zur Laufzeit mit „First argument must
	// use the object destructuring pattern" abgelehnt.
	// biome-ignore lint/correctness/noEmptyPattern: siehe oben
	stack: async ({}, use) => {
		await use(readStack())
	},
	zitadel: async ({ stack, request }, use) => {
		await use(new Zitadel(stack, request))
	},
})

export { expect }
