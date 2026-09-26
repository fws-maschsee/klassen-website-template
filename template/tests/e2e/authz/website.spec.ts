import { CALENDAR_PATH } from '../../../src/site.config'
import { expect, type StackUser, signIn, test } from './fixtures'

const NICHT_FREIGESCHALTET = /noch nicht freigeschaltet/i

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

		await page.waitForURL(/\/ui\/v2\/login\/loginname/, { timeout: 30_000 })
		expect(new URL(page.url()).origin).not.toBe(stack.appOrigin)
		await expect(page.locator('input[name="loginName"]')).toHaveCount(1)
	})

	test('ohne Anmeldung bleibt der Kalender erreichbar', async ({ request }) => {
		const response = await request.get(CALENDAR_PATH)
		expect(response.status()).toBe(200)
		expect(await response.text()).toContain('BEGIN:VCALENDAR')
	})

	test('ohne Anmeldung liefert eine Nicht-Seiten-Anfrage 401', async ({
		request,
	}) => {
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
		expect(response.status()).not.toBe(403)
	})

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
