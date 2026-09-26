import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import express from 'express'
import { openDb } from './src/lib/db/index.js'
import { assertInstanceMatches, instanceLabel } from './src/lib/db/instance.js'
import { port, publicBaseUrl } from './src/server/config.js'
import {
	mcpAuthMiddleware,
	mcpRequestHandler,
} from './src/server/mcp/handler.js'
import { mcpOAuthProvider } from './src/server/oauth/provider.js'
import { startQueueWorker } from './src/server/queue-worker.js'

const instance = assertInstanceMatches(openDb())

const app = express()

app.set('trust proxy', 1)

app.use(
	mcpAuthRouter({
		provider: mcpOAuthProvider,
		issuerUrl: new URL(publicBaseUrl()),
		resourceName: `${instanceLabel()} MCP`,
		scopesSupported: ['mcp'],
	}),
)

app.use('/mcp', express.json(), mcpAuthMiddleware, mcpRequestHandler)

app.use(express.static('dist/client'))

const astroEntry = './dist/server/entry.mjs'
// biome-ignore lint/suspicious/noExplicitAny: der Astro-SSR-Handler ist untypisiert
const { handler } = (await import(astroEntry)) as { handler: any }
app.use(handler)

app.listen(port(), () => {
	console.log(
		`[server] ${instance.configured} laeuft auf http://localhost:${port()}`,
	)
	startQueueWorker()
})
