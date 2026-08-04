import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
	testDir: './tests/e2e',
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
		// `mkdir -p data`: das Verzeichnis steht in .gitignore und existiert im
		// frischen CI-Checkout nicht. Weder dbmate noch der Server legen es an.
		command: 'mkdir -p data && npm run build && npm run preview',
		url: 'http://localhost:4321',
		reuseExistingServer: true,
		timeout: 180000,
		env: {
			...process.env,
			// Ohne diese Variable verlangt die Middleware eine Anmeldung gegen
			// PocketBase, und jeder Test bekäme eine 401.
			DISABLE_AUTH: 'true',
		},
	},
})
