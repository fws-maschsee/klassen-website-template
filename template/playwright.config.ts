import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
	testDir: './tests/e2e',
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
