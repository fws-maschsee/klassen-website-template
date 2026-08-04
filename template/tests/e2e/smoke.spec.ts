import { expect, test } from '@playwright/test'

/**
 * Rauchtest: Prüft, dass die Grundgerüst-Seiten rendern. Bewusst ohne feste
 * Anzahlen von Berichten oder Unterlagen - der Test soll nicht bei jedem neuen
 * Beitrag rot werden.
 */
test.describe('Rauchtest', () => {
	test('Startseite lädt', async ({ page }) => {
		await page.goto('/')
		await expect(page.locator('h1')).toContainText('Willkommen')
	})

	test('Abmelden-Seite lädt', async ({ page }) => {
		await page.goto('/logout')
		await expect(page.locator('h1')).toContainText('Abmelden')
	})

	test('Unterlagen laden', async ({ page }) => {
		await page.goto('/docs')
		await expect(page.locator('h1')).toContainText('Startseite')
	})

	test('Berichte laden', async ({ page }) => {
		await page.goto('/blog')
		await expect(page.locator('h1')).toContainText('Berichte')
		// Mindestens der Willkommens-Beitrag muss da sein.
		await expect(page.getByTestId('blog-post-item').first()).toBeVisible()
	})

	test('Putzplan ist erreichbar', async ({ page }) => {
		await page.goto('/docs/putzen/putzplan')
		await expect(page.locator('h1')).toContainText('Putzplan')
	})
})
