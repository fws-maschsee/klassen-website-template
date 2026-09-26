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

const here = dirname(fileURLToPath(import.meta.url))
const statePath = resolve(here, '.stack/stack.json')

export type StackUser = {
	key: string
	userId: string
	email: string
	password: string
	grantId?: string
}

export type Stack = {
	issuer: string
	loginBaseUri: string
	appOrigin: string
	adminToken: string
	orgId: string
	appServiceToken: string
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

	setGrantRoles(user: StackUser, roles: string[]) {
		return this.call(
			'put',
			`/management/v1/users/${user.userId}/grants/${user.grantId}`,
			{ roleKeys: roles },
		)
	}

	removeGrant(user: StackUser) {
		return this.call(
			'delete',
			`/management/v1/users/${user.userId}/grants/${user.grantId}`,
		)
	}

	async rolesOf(user: StackUser): Promise<string[]> {
		const result = await this.call(
			'post',
			'/management/v1/users/grants/_search',
			{
				query: { limit: 1000 },
				// Nicht per userIdQuery: die liefert an dieser Schnittstelle still null Zeilen.
				queries: [{ projectIdQuery: { projectId: this.stack.ownProjectId } }],
			},
		)
		const rows: { userId?: string; roleKeys?: string[]; state?: string }[] =
			result.result ?? []
		const row = rows.find((entry) => entry.userId === user.userId)
		if (
			!row ||
			// Exakter Vergleich: auch USER_GRANT_STATE_INACTIVE endet auf ACTIVE.
			(row.state ?? 'USER_GRANT_STATE_ACTIVE') !== 'USER_GRANT_STATE_ACTIVE'
		) {
			return []
		}
		return row.roleKeys ?? []
	}
}

export const signIn = async (
	page: Page,
	stack: Stack,
	user: StackUser,
	options: { startAt?: string } = {},
): Promise<void> => {
	await page.goto(options.startAt ?? '/')

	await page.waitForURL(/\/ui\/v2\/login\/loginname/, { timeout: 30_000 })
	// Beim clientseitigen Umschalten stehen kurz die Felder zweier Seiten im Dokument; toHaveCount(1) wartet das ab.
	// data-testid statt Beschriftung, weil Login v2 mehrsprachig ist.
	const loginName = page.locator('input[name="loginName"]')
	await expect(loginName).toHaveCount(1)
	await loginName.fill(user.email)
	await page.getByTestId('submit-button').click()

	await page.waitForURL(/\/ui\/v2\/login\/password/, { timeout: 30_000 })
	const password = page.locator('input[type="password"]')
	await expect(password).toHaveCount(1)
	await password.fill(user.password)
	await page.getByTestId('submit-button').click()

	await page.waitForURL((url) => url.origin === stack.appOrigin, {
		timeout: 60_000,
	})
}

const base64url = (input: Buffer): string => input.toString('base64url')

export type McpToken = {
	accessToken: string
	clientId: string
	clientSecret: string
}

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
	isError: boolean
	text: string
}

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

export const test = base.extend<{ stack: Stack; zitadel: Zitadel }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright verlangt Destrukturierung, auch ohne Fixtures
	stack: async ({}, use) => {
		await use(readStack())
	},
	zitadel: async ({ stack, request }, use) => {
		await use(new Zitadel(stack, request))
	},
})

export { expect }
