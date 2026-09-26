import { defineConfig, devices } from '@playwright/test'

const port = process.env.AUTHZ_APP_PORT ?? '4322'

// Kein webServer: die App braucht OIDC-Zugangsdaten, die erst stack.mjs beim Einrichten von ZITADEL erzeugt.
export default defineConfig({
	testDir: './tests/e2e/authz',
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	// Kein Retry: ein erst beim zweiten Mal grüner Test verdeckt Reihenfolgefehler beim Rollenwechsel.
	retries: 0,
	// Alle Tests teilen eine ZITADEL-Instanz und eine SQLite-Datei.
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
