import { defineConfig } from 'vitest/config'

/**
 * Die Tests laufen in Node, nicht in der Workers-Runtime: Der Worker benutzt
 * nur `fetch`, `crypto.subtle` und Web-Streams, und die gibt es in Node 20+
 * genauso. Das spart die `workers`-Testumgebung samt Miniflare-Start.
 */
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node',
	},
})
