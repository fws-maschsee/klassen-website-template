import { CALENDAR_PATH } from '../../../src/site.config'
import { expect, type StackUser, signIn, test } from './fixtures'

/**
 * Autorisierung der Weboberflaeche gegen ein echtes ZITADEL.
 *
 * Jeder Test hier steht fuer einen Fehler, den bisher ein Mensch beim
 * Ausprobieren gefunden hat. Die beiden wichtigsten sind „Rechteentzug wirkt"
 * und „Rechtevergabe wirkt": sie halten fest, dass die Berechtigung bei JEDER
 * Anfrage neu gilt und nicht das ist, was irgendwann einmal in ein Token
 * geschrieben wurde.
 */

/** Text der Seite fuer „angemeldet, aber ohne Freigabe fuer diese Klasse". */
const NICHT_FREIGESCHALTET = /noch nicht freigeschaltet/i

/**
 * Ein Schreibzugriff der Oberflaeche, ohne Formular ausgefuellt zu klicken.
 *
 * Bewusst ueber `page.request`: der Aufruf traegt die Cookies DERSELBEN
 * Sitzung, ohne sie zu erneuern. Nur so ist die Aussage „derselbe Zugang,
 * ohne Neuanmeldung" ueberhaupt pruefbar. Und er geht direkt an den
 * POST-Endpunkt und nicht ueber die Formularfelder, weil ein POST auch dann
 * ankommt, wenn die Oberflaeche das Formular gar nicht erst anzeigt — genau
 * das ist die Luecke, die eine reine Anzeige-Pruefung offen liesse.
 */
const versucheSchreibzugriff = async (
	page: import('@playwright/test').Page,
	nachname: string,
) =>
	page.request.post('/verwaltung', {
		form: {
			action: 'upsert',
			id: '',
			first_name: 'Test',
			last_name: nachname,
			email: '',
		},
		maxRedirects: 0,
	})

test.describe('Weboberflaeche', () => {
	test('ohne Anmeldung fuehrt jede Seite zur zentralen Anmeldung', async ({
		page,
		stack,
	}) => {
		await page.goto('/')

		// Gelandet ist der Browser beim Anmeldedienst, nicht auf der Seite.
		await page.waitForURL(/\/ui\/v2\/login\//, { timeout: 30_000 })
		expect(new URL(page.url()).origin).not.toBe(stack.appOrigin)
		await expect(page.locator('input[name="loginName"]')).toBeVisible()
	})

	test('ohne Anmeldung bleibt der Kalender erreichbar', async ({ request }) => {
		// Daran haengen die bestehenden Abos der Eltern. Eine Kalender-App
		// meldet sich naturgemaess nirgends an; wird dieser Pfad geschuetzt,
		// brechen saemtliche Abos still — ohne Fehlermeldung bei irgendjemandem.
		const response = await request.get(CALENDAR_PATH)
		expect(response.status()).toBe(200)
		expect(await response.text()).toContain('BEGIN:VCALENDAR')
	})

	test('ohne Anmeldung liefert eine Nicht-Seiten-Anfrage 401', async ({
		request,
	}) => {
		// Kalender-Clients, Monitoring und APIs bekommen einen klaren Fehler
		// statt einer Umleitung, mit der sie nichts anfangen koennen.
		const response = await request.get('/verwaltung', {
			headers: { Accept: 'application/json' },
			maxRedirects: 0,
		})
		expect(response.status()).toBe(401)
	})

	test('mitglied der eigenen Klasse sieht den Inhalt', async ({
		page,
		stack,
	}) => {
		await signIn(page, stack, stack.users.mitglied)
		await expect(page.locator('h1')).toContainText('Willkommen')
	})

	test('wer nur in der anderen Klasse mitglied ist, wird abgewiesen', async ({
		page,
		stack,
	}) => {
		// Der wichtigste Fall: beide Klassen benutzen denselben Rollennamen
		// `mitglied`. Die Trennung entsteht allein daraus, dass der Client
		// dieser Seite zu EINEM Projekt gehoert und ZITADEL nur dessen Rollen
		// in das Token legt. Eine Implementierung, die den Rollennamen ohne
		// Projektbezug prueft, sperrt hier beide Klassen gegenseitig auf und
		// faellt genau an dieser Stelle durch.
		await signIn(page, stack, stack.users.fremd)
		await expect(page.locator('body')).toContainText(NICHT_FREIGESCHALTET)
		await expect(page.locator('h1')).not.toContainText('Willkommen')
	})

	test('wer gar keine Rolle hat, wird abgewiesen', async ({ page, stack }) => {
		await signIn(page, stack, stack.users.ohnerolle)
		await expect(page.locator('body')).toContainText(NICHT_FREIGESCHALTET)
	})

	test('mitglied darf lesen, aber nicht schreiben', async ({ page, stack }) => {
		await signIn(page, stack, stack.users.mitglied)
		await page.goto('/verwaltung')
		await expect(page.locator('h1')).toContainText('Verwaltung')

		const response = await versucheSchreibzugriff(page, 'DarfNicht')
		expect(response.status()).toBe(403)
	})

	test('admin darf schreiben', async ({ page, stack }) => {
		await signIn(page, stack, stack.users.admin)
		const response = await versucheSchreibzugriff(page, 'DarfSchon')
		// Erfolg heisst: die Seite rendert wieder (200) oder leitet auf sich
		// selbst um — jedenfalls KEIN 403.
		expect(response.status()).not.toBe(403)
	})

	/**
	 * Der Test, der heute gefehlt hat.
	 *
	 * Bisher las die Anwendung die Rollen genau einmal — beim Anmelden — und
	 * schrieb sie in ein verschluesseltes Sitzungs-Cookie. Ein entzogenes
	 * Recht wirkte damit erst, wenn diese Sitzung ablief; der automatische
	 * Refresh reichte die alten Rollen einfach weiter. Praktisch hiess das:
	 * nie.
	 *
	 * Geprueft wird deshalb ausdruecklich OHNE Neuanmeldung: derselbe Browser,
	 * dasselbe Cookie, nur ein anderer Zustand in ZITADEL.
	 */
	test('Rechteentzug wirkt ohne Neuanmeldung', async ({
		page,
		stack,
		zitadel,
	}) => {
		const user = stack.users.entzug
		await signIn(page, stack, user)

		const vorher = await versucheSchreibzugriff(page, 'VorDemEntzug')
		expect(
			vorher.status(),
			'Vorbedingung: dieser Zugang hat admin und darf schreiben',
		).not.toBe(403)

		// Nur die Rolle `admin` faellt weg, `mitglied` bleibt: der Zugang soll
		// die Seite weiter sehen und nur nichts mehr aendern duerfen.
		await zitadel.setGrantRoles(user, ['mitglied'])
		await erwarteRollen(zitadel, user, ['mitglied'])

		await expect
			.poll(
				async () =>
					(await versucheSchreibzugriff(page, 'NachDemEntzug')).status(),
				{
					message:
						'Nach dem Entzug der Rolle admin darf derselbe Zugang nicht mehr schreiben',
					timeout: 30_000,
					intervals: [500, 1000, 2000],
				},
			)
			.toBe(403)
	})

	/**
	 * Die Gegenrichtung, und sie ist der Fehler des Betreibers: er hatte
	 * `admin` in ZITADEL, sein Zugang blieb trotzdem `mitglied`, weil die
	 * Rollen aus der bestehenden Sitzung stammten statt aus einer frischen
	 * Abfrage. Neuverbinden half nicht; nur eine neue Sitzung.
	 */
	test('Rechtevergabe wirkt ohne Neuanmeldung', async ({
		page,
		stack,
		zitadel,
	}) => {
		const user = stack.users.vergabe
		await signIn(page, stack, user)

		const vorher = await versucheSchreibzugriff(page, 'VorDerVergabe')
		expect(
			vorher.status(),
			'Vorbedingung: dieser Zugang hat nur mitglied und darf nicht schreiben',
		).toBe(403)

		await zitadel.setGrantRoles(user, ['mitglied', 'admin'])
		await erwarteRollen(zitadel, user, ['admin', 'mitglied'])

		await expect
			.poll(
				async () =>
					(await versucheSchreibzugriff(page, 'NachDerVergabe')).status(),
				{
					message:
						'Nach der Vergabe der Rolle admin darf derselbe Zugang sofort schreiben',
					timeout: 30_000,
					intervals: [500, 1000, 2000],
				},
			)
			.not.toBe(403)
	})
})

/**
 * Wartet, bis ZITADEL selbst die neuen Rollen fuehrt.
 *
 * ZITADEL ist ereignisbasiert: ein `PUT` auf einen Grant ist beantwortet,
 * bevor die lesenden Projektionen ihn kennen. Ohne diesen Zwischenschritt
 * pruefte der Test gelegentlich die Anwendung gegen einen Stand, den der
 * Verzeichnisdienst noch gar nicht hat — und waere dann rot, ohne dass an der
 * Anwendung etwas falsch waere. Genau die Sorte Test, die nach zwei Wochen
 * ignoriert wird.
 */
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
