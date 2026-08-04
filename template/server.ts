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

/**
 * Produktions-Entrypoint. Express umschliesst den Astro-SSR-Handler, weil zwei
 * Dinge ausserhalb von Astro leben muessen:
 *
 *  - Der MCP-Endpunkt `/mcp` braucht das Express-`req`/`res`-Paar fuer den
 *    Streamable-HTTP-Transport des SDK.
 *  - Die OAuth-Endpunkte (`/authorize`, `/token`, `/register`, `/revoke` und
 *    die `.well-known`-Metadaten) mountet `mcpAuthRouter` auf Root-Ebene.
 *
 * Alles andere — Seiten, Content, die bestehende Anmeldung — laeuft
 * unveraendert durch die Astro-Middleware.
 */

// Bevor irgendetwas laeuft: gehoert die gemountete Datenbank ueberhaupt zu
// dieser Klasse? Ein Mismatch bedeutet, dass der naechste Versand an die
// falsche Elternschaft ginge. Lieber gar nicht starten.
const instance = assertInstanceMatches(openDb())

const app = express()

// Hinter einem Reverse-Proxy laufen wir mit X-Forwarded-*-Headern, damit
// Express (und das Rate-Limiting des MCP-SDK) die echten Client-IPs sieht.
app.set('trust proxy', 1)

// OAuth-Endpunkte fuer den MCP-Client (Discovery, DCR, Token, Revoke).
// `/authorize` leitet auf unsere Astro-Seite `/oauth/consent` weiter, die
// hinter der normalen Anmeldung liegt.
app.use(
	mcpAuthRouter({
		provider: mcpOAuthProvider,
		issuerUrl: new URL(publicBaseUrl()),
		resourceName: `${instanceLabel()} MCP`,
		scopesSupported: ['mcp'],
	}),
)

// MCP-Endpunkt mit eigenem Bearer-Auth-Layer.
app.use('/mcp', express.json(), mcpAuthMiddleware, mcpRequestHandler)

app.use(express.static('dist/client'))

// Der Astro-SSR-Entry entsteht erst beim Build. Der Pfad liegt deshalb in einer
// Variable — sonst wollte die Typpruefung ein Modul aufloesen, das im
// Quellbaum gar nicht existiert.
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
