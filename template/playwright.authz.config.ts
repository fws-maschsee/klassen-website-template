import { defineConfig, devices } from '@playwright/test'

/**
 * Eigene Konfiguration fuer die Autorisierungs-Tests.
 *
 * Sie steht bewusst neben `playwright.config.ts` und nicht darin: der
 * Smoke-Test dort faehrt den Server mit `DISABLE_AUTH=true` hoch, weil er
 * Inhalte prueft und die Anmeldung nur im Weg waere. Diese Tests pruefen
 * genau die Anmeldung — beides in einer Konfiguration hiesse, zwei
 * unvereinbare Server in denselben Lauf zu zwingen.
 *
 * Es gibt hier keinen `webServer`. Den ganzen Stack — PostgreSQL, ZITADEL,
 * dessen Anmeldeoberflaeche und diese Anwendung — startet
 * `tests/e2e/authz/stack.mjs`, weil Playwright seinen `webServer` VOR dem
 * `globalSetup` hochfaehrt: die OIDC-Zugangsdaten, mit denen die Anwendung
 * starten muss, entstehen aber erst beim Einrichten von ZITADEL. Also:
 *
 *   npm run authz:up      Stack hochfahren (idempotent)
 *   npm run test:e2e:authz
 *   npm run authz:down
 */

const port = process.env.AUTHZ_APP_PORT ?? '4322'

export default defineConfig({
	testDir: './tests/e2e/authz',
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	// Kein automatischer zweiter Versuch. Diese Tests veraendern Rollen in
	// ZITADEL und raeumen sie danach wieder auf; ein stiller Neuversuch
	// verdeckt genau die Reihenfolgeprobleme, die hier gefaehrlich waeren.
	// Ein Test, der nur beim zweiten Mal gruen ist, ist ein kaputter Test.
	retries: 0,
	// Ein Arbeiter. Die Tests teilen sich EINE ZITADEL-Instanz und EINE
	// Anwendung mit EINER SQLite-Datei; parallele Laeufe wuerden sich
	// gegenseitig die Rollen unter den Fuessen wegziehen.
	workers: 1,
	reporter: process.env.CI ? 'github' : 'html',
	timeout: 120_000,
	use: {
		baseURL: `http://localhost:${port}`,
		trace: 'on-first-retry',
		video: process.env.CI ? 'retain-on-failure' : 'off',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
})
