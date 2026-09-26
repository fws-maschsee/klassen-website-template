import { defineMiddleware } from 'astro:middleware'
import {
	GrantsConfigError,
	GrantsUnavailableError,
} from './server/auth/grants.js'
import { authenticate, OidcConfigError } from './server/auth/oidc.js'
import { CALENDAR_PATH, CLASS_NAME, CONTACT_MAIL } from './site.config'

// /public/: Kalender-Apps melden sich nie an, geschützt brächen die Abos still.
// /api/lists/: der Mail-Worker hat kein Cookie und authentifiziert sich per HMAC-Signatur.
const publicPaths = ['/public/', '/api/lists/']

// Beim Start auffallen, nicht erst wenn die Kalender-Abos der Eltern stillstehen.
if (!publicPaths.some((prefix) => CALENDAR_PATH.startsWith(prefix))) {
	throw new Error(
		`CALENDAR_PATH (${CALENDAR_PATH}) liegt nicht unter einem oeffentlichen Pfad (${publicPaths.join(', ')})`,
	)
}

const AUTH_PREFIX = '/auth/'

export const onRequest = defineMiddleware(async (context, next) => {
	if (process.env.DISABLE_AUTH === 'true') {
		return next()
	}

	const url = new URL(context.request.url)
	const path = url.pathname

	if (publicPaths.some((p) => path.startsWith(p))) {
		return next()
	}

	// Die Anmeldung selbst nicht bewachen, sonst Endlosschleife.
	if (path.startsWith(AUTH_PREFIX)) {
		return next()
	}

	try {
		const { response, session, setCookie } = await authenticate(
			context.request,
			{ className: `die ${CLASS_NAME}`, contactMail: CONTACT_MAIL },
		)

		if (response) {
			return response
		}

		context.locals.user = session ?? undefined

		const pageResponse = await next()
		if (setCookie) {
			// Die Sitzung wurde gerade beim IdP verlängert; ohne das Cookie liefe bei jeder Anfrage erneut ein Refresh.
			pageResponse.headers.append('Set-Cookie', setCookie)
		}
		return pageResponse
	} catch (error) {
		// Verweigern statt durchwinken: ZITADEL läuft im selben Cluster, fehlt es, ist das ein Ausfall.
		if (error instanceof GrantsUnavailableError) {
			return new Response(
				'Die Berechtigungspruefung ist gerade nicht erreichbar. Bitte spaeter erneut versuchen.',
				{
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' },
				},
			)
		}
		// 503 statt Absturz: der CI-Smoke-Test startet das Image ohne Secrets und erwartet eine Antwort.
		if (
			error instanceof OidcConfigError ||
			error instanceof GrantsConfigError
		) {
			return new Response(
				'Die Anmeldung ist auf diesem Server nicht konfiguriert.',
				{
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' },
				},
			)
		}
		throw error
	}
})
