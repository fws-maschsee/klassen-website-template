import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
	testDir: './tests/e2e',
	// Die Autorisierungs-Tests unter tests/e2e/authz/ gehoeren NICHT hierher.
	// Dieser Lauf startet den Server mit `DISABLE_AUTH=true`, weil er Inhalte
	// prueft; jene pruefen die Anmeldung selbst und brauchen einen Server mit
	// echter Anmeldung samt lokalem ZITADEL. Sie haben deshalb eine eigene
	// Konfiguration: playwright.authz.config.ts.
	testIgnore: '**/authz/**',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? 'github' : 'html',
	use: {
		baseURL: 'http://localhost:4321',
		trace: 'on-first-retry',
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	webServer: {
		// Seit der Adapter im `middleware`-Modus laeuft, gibt es kein
		// `astro preview` mehr: der Server ist `server.ts` hinter Express. Vorher
		// muessen die Migrations laufen, sonst findet der Start keine Tabellen.
		// `mkdir -p data` gehoert davor: `data/` ist gitignoriert (dort liegen
		// Namen und Adressen der Eltern), eine frisch erzeugte Klasse hat das
		// Verzeichnis also nicht. Ohne es scheitert dbmate mit "unable to open
		// database file", der Server kommt nie hoch, und Playwright meldet nur
		// "Process from config.webServer was not able to start".
		command:
			'mkdir -p data && npm run build && npm run db:migrate && npm start',
		url: 'http://localhost:4321',
		reuseExistingServer: true,
		timeout: 120000,
		env: {
			...process.env,
			DISABLE_AUTH: 'true',
			PORT: '4321',
			DB_PATH: './data/e2e.db',
			DATABASE_URL: 'sqlite:./data/e2e.db',
		},
	},
})
