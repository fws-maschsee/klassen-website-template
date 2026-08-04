import {
	callMcpTool,
	connectMcpClient,
	expect,
	type StackUser,
	signIn,
	test,
} from './fixtures'

/**
 * Dieselben Regeln am MCP-Endpunkt.
 *
 * Der Grund, dass es diese Datei ueberhaupt gibt: `/mcp` ist ein zweiter Weg
 * an dieselben Daten. Waere er nur schwaecher geprueft als ein Klick in der
 * Oberflaeche, waere die ganze Absicherung mit drei Zeilen zu umgehen — man
 * verbindet einen MCP-Client und aendert, was man ueber die Seite nicht
 * duerfte.
 *
 * Der Weg zum Token ist hier absichtlich der echte: dynamische Registrierung,
 * Authorization Code mit PKCE, Zustimmung im Browser. Genau auf diesem Weg
 * ist heute der zweite Fehler entstanden — das frisch ausgestellte Token trug
 * die Rollen der bestehenden Sitzung der Website statt der, die in ZITADEL
 * standen.
 */

/** Ein Schreibzugriff ueber MCP: derselbe, den ein Klick in der Verwaltung tut. */
const schreibeUeberMcp = (
	request: import('@playwright/test').APIRequestContext,
	stack: import('./fixtures').Stack,
	accessToken: string,
	nachname: string,
) =>
	callMcpTool(request, stack, accessToken, 'upsert_mitglied', {
		first_name: 'Test',
		last_name: nachname,
	})

test.describe('MCP-Endpunkt', () => {
	test('ohne Token antwortet /mcp mit 401', async ({ request, stack }) => {
		const response = await request.post(`${stack.appOrigin}/mcp`, {
			headers: {
				Accept: 'application/json, text/event-stream',
				'Content-Type': 'application/json',
			},
			data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
		})
		expect(response.status()).toBe(401)
		// Damit ein Client weiss, wo er sich ein Token holt.
		expect(response.headers()['www-authenticate']).toBeTruthy()
	})

	test('ein erfundenes Token wird abgewiesen', async ({ request, stack }) => {
		const result = await schreibeUeberMcp(
			request,
			stack,
			'kein-echtes-token',
			'MitErfundenemToken',
		)
		expect(result.status, result.text).toBeGreaterThanOrEqual(400)
		expect(result.isError).toBe(true)
	})

	test('ein erfundenes Token wird mit 401 abgewiesen, nicht mit 500', async ({
		request,
		stack,
	}) => {
		// Bewusst getrennt von der Pruefung darueber. DASS abgewiesen wird, ist
		// die Sicherheitsaussage; WOMIT, entscheidet, ob ein Client sich davon
		// erholen kann: auf 401 holt er sich ein neues Token, auf 500 haelt er
		// den Server fuer kaputt und versucht es wieder und wieder. Zwei
		// getrennte Tests, damit ein Fehlschlag hier nicht die wichtigere
		// Aussage verdeckt.
		const result = await schreibeUeberMcp(
			request,
			stack,
			'kein-echtes-token',
			'MitErfundenemToken',
		)
		expect(result.status, result.text).toBe(401)
	})

	test('admin darf ueber MCP aendern', async ({ page, request, stack }) => {
		await signIn(page, stack, stack.users.admin)
		const token = await connectMcpClient(page, stack)

		const result = await schreibeUeberMcp(
			request,
			stack,
			token.accessToken,
			'McpAdminDarf',
		)
		expect(result.isError, result.text).toBe(false)
	})

	test('mitglied darf ueber MCP nicht aendern', async ({
		page,
		request,
		stack,
	}) => {
		await signIn(page, stack, stack.users.mitglied)
		const token = await connectMcpClient(page, stack)

		const result = await schreibeUeberMcp(
			request,
			stack,
			token.accessToken,
			'McpMitgliedDarfNicht',
		)
		expect(result.isError, result.text).toBe(true)
		// Der Text soll sagen, WAS fehlt und WER es geben kann — sonst sucht der
		// Mensch davor den Fehler im Server statt in seiner Berechtigung.
		expect(result.text).toContain('admin')
	})

	test('wer nur in der anderen Klasse mitglied ist, bekommt kein Token', async ({
		page,
		stack,
	}) => {
		await signIn(page, stack, stack.users.fremd)

		// Die Zustimmungsseite liegt hinter derselben Pruefung wie die uebrige
		// Seite. Wer hier nicht hereinkommt, kann auch keinen MCP-Zugang
		// erteilen — sonst waere der Endpunkt der Weg an der Klassentrennung
		// vorbei.
		const registrierung = await page.request.post(
			`${stack.appOrigin}/register`,
			{
				data: {
					client_name: 'E2E MCP Client (fremde Klasse)',
					redirect_uris: [`${stack.appOrigin}/e2e/mcp-callback`],
					grant_types: ['authorization_code'],
					response_types: ['code'],
					token_endpoint_auth_method: 'client_secret_post',
					scope: 'mcp',
				},
			},
		)
		const client = await registrierung.json()

		const authorize = new URL(`${stack.appOrigin}/authorize`)
		authorize.searchParams.set('client_id', client.client_id)
		authorize.searchParams.set('response_type', 'code')
		authorize.searchParams.set(
			'redirect_uri',
			`${stack.appOrigin}/e2e/mcp-callback`,
		)
		authorize.searchParams.set('code_challenge', 'x'.repeat(43))
		authorize.searchParams.set('code_challenge_method', 'S256')
		authorize.searchParams.set('scope', 'mcp')

		await page.goto(authorize.toString())
		await expect(
			page.getByRole('button', { name: 'Autorisieren' }),
			'die Zustimmungsseite darf diesem Zugang gar nicht erst angeboten werden',
		).toHaveCount(0)
		await expect(page.locator('body')).not.toContainText(
			'Anwendung autorisieren',
		)
	})

	/**
	 * Der Fall des Betreibers, am MCP-Endpunkt.
	 *
	 * Bisher wanderten die Rollen beim Zustimmen in den Authorization Code und
	 * von dort in die Tokens. Ein Token war damit eine Momentaufnahme, die nie
	 * wieder abgeglichen wurde — ein entzogenes Recht wirkte nicht, und der
	 * automatische Refresh reichte die alte Momentaufnahme weiter.
	 */
	test('Rechteentzug wirkt fuer ein bereits ausgestelltes Token', async ({
		page,
		request,
		stack,
		zitadel,
	}) => {
		const user = stack.users.mcpEntzug
		await signIn(page, stack, user)
		const token = await connectMcpClient(page, stack)

		const vorher = await schreibeUeberMcp(
			request,
			stack,
			token.accessToken,
			'McpVorDemEntzug',
		)
		expect(
			vorher.isError,
			`Vorbedingung: dieser Zugang hat admin und darf aendern. ${vorher.text}`,
		).toBe(false)

		await zitadel.setGrantRoles(user, ['mitglied'])
		await erwarteRollen(zitadel, user, ['mitglied'])

		// DASSELBE Token, kein neuer Anmeldevorgang, keine neue Zustimmung.
		await expect
			.poll(
				async () =>
					(
						await schreibeUeberMcp(
							request,
							stack,
							token.accessToken,
							'McpNachDemEntzug',
						)
					).isError,
				{
					message:
						'Nach dem Entzug der Rolle admin darf dasselbe Token nicht mehr aendern',
					timeout: 30_000,
					intervals: [500, 1000, 2000],
				},
			)
			.toBe(true)
	})

	test('Rechtevergabe wirkt fuer ein bereits ausgestelltes Token', async ({
		page,
		request,
		stack,
		zitadel,
	}) => {
		const user = stack.users.mcpVergabe
		await signIn(page, stack, user)
		const token = await connectMcpClient(page, stack)

		const vorher = await schreibeUeberMcp(
			request,
			stack,
			token.accessToken,
			'McpVorDerVergabe',
		)
		expect(
			vorher.isError,
			'Vorbedingung: dieser Zugang hat nur mitglied und darf nicht aendern',
		).toBe(true)

		await zitadel.setGrantRoles(user, ['mitglied', 'admin'])
		await erwarteRollen(zitadel, user, ['admin', 'mitglied'])

		await expect
			.poll(
				async () =>
					(
						await schreibeUeberMcp(
							request,
							stack,
							token.accessToken,
							'McpNachDerVergabe',
						)
					).isError,
				{
					message:
						'Nach der Vergabe der Rolle admin darf dasselbe Token sofort aendern',
					timeout: 30_000,
					intervals: [500, 1000, 2000],
				},
			)
			.toBe(false)
	})

	/**
	 * Der dritte Fehler von heute: widerrufene Zugriffe blieben in der
	 * Oberflaeche stehen, obwohl die Tokens korrekt widerrufen waren. Wer das
	 * sieht, glaubt, der Widerruf habe nicht gewirkt, und widerruft noch
	 * einmal — oder, schlimmer, glaubt umgekehrt einem Eintrag, den es nicht
	 * mehr gibt.
	 */
	test('„Zugriff beenden" entwertet das Token und raeumt die Anzeige', async ({
		page,
		request,
		stack,
	}) => {
		const user = stack.users.mcpWiderruf
		await signIn(page, stack, user)
		const token = await connectMcpClient(page, stack)

		const vorher = await schreibeUeberMcp(
			request,
			stack,
			token.accessToken,
			'McpVorDemWiderruf',
		)
		expect(vorher.isError, vorher.text).toBe(false)

		await page.goto('/verwaltung')
		const zeile = page.locator('tr', { hasText: token.clientId })
		await expect(
			zeile,
			'die verbundene Anwendung steht in der Verwaltung',
		).toBeVisible()
		await zeile.getByRole('button', { name: 'Zugriff beenden' }).click()

		// Erstens: das Token ist wirklich tot. Ob die Absage dabei das richtige
		// 401 traegt, prueft weiter oben ein eigener Test — hier zaehlt nur,
		// dass der Zugriff nicht mehr durchgeht.
		const nachher = await schreibeUeberMcp(
			request,
			stack,
			token.accessToken,
			'McpNachDemWiderruf',
		)
		expect(nachher.status, nachher.text).toBeGreaterThanOrEqual(400)

		// Zweitens: die Oberflaeche sagt dasselbe. Kein aktiver Zugriff mehr.
		await page.goto('/verwaltung')
		const danach = page.locator('tr', { hasText: token.clientId })
		if (await danach.count()) {
			await expect(
				danach,
				'kein aktives Zugriffs- und kein aktives Erneuerungs-Token mehr',
			).toContainText('0 / 0')
		}
	})
})

/** Siehe website.spec.ts — ZITADEL ist ereignisbasiert und liest verzoegert. */
const erwarteRollen = async (
	zitadel: { rolesOf: (user: StackUser) => Promise<string[]> },
	user: StackUser,
	roles: string[],
) => {
	await expect
		.poll(async () => (await zitadel.rolesOf(user)).sort().join(','), {
			message: `ZITADEL fuehrt fuer ${user.email} die Rollen ${roles.join(', ')}`,
			timeout: 30_000,
			intervals: [250, 500, 1000],
		})
		.toBe([...roles].sort().join(','))
}
