import { defineConfig, devices } from '@playwright/test'

const port = process.env.AUTHZ_APP_PORT ?? '4322'

export default defineConfig({
	testDir: './tests/e2e/authz',
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: 0,
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
