import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		// Node statt Workers-Runtime: der Worker nutzt nur fetch, crypto.subtle und Web-Streams.
		environment: 'node',
	},
})
