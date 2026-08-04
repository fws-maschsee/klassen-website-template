import { defineMiddleware } from 'astro:middleware'
import {
	GrantsConfigError,
	GrantsUnavailableError,
} from './server/auth/grants.js'
import { authenticate, OidcConfigError } from './server/auth/oidc.js'
import { CALENDAR_PATH, CLASS_NAME, CONTACT_MAIL } from './site.config'

// Öffentliche Pfade, die keine Anmeldung brauchen.
//
// - `/public/` : Der Klassenkalender muss frei erreichbar bleiben, damit die
//   Kalender-Abos der Eltern weiter funktionieren. Eine Kalender-App meldet
//   sich naturgemäß nirgends an; wird dieser Pfad geschützt, brechen sämtliche
//   Abos still — ohne Fehlermeldung bei irgendjemandem.
// - `/api/lists/` : Die Endpunkte für den Cloudflare-Email-Worker. Sie sind
//   NICHT ungeschützt, sondern authentifizieren sich über eine HMAC-Signatur
//   mit dem geteilten `LIST_WEBHOOK_SECRET` (siehe src/lib/lists/signature.ts).
//   Eine Cookie-Anmeldung kann ein Mail-Worker naturgemäß nicht mitbringen.
const publicPaths = ['/public/', '/api/lists/']

if (!publicPaths.some((prefix) => CALENDAR_PATH.startsWith(prefix))) {
	// Absicherung gegen eine spätere Änderung an einer der beiden Stellen:
	// liegt der Kalender nicht mehr unter einem offenen Pfad, soll das beim
	// Bauen auffallen und nicht erst, wenn die Abos der Eltern still stehen.
	throw new Error(
		`CALENDAR_PATH (${CALENDAR_PATH}) liegt nicht unter einem oeffentlichen Pfad (${publicPaths.join(', ')})`,
	)
}

/**
 * Der Anmeldevorgang selbst. Diese Pfade dürfen nicht bewacht werden — sie
 * SIND die Anmeldung; eine Prüfung hier ergäbe eine Endlosschleife.
 *
 * Bedient werden sie von echten Routen unter `src/pages/auth/`. Der
 * Node-Adapter läuft hinter Express im `middleware`-Modus und ruft die
 * Astro-Middleware nur für Pfade auf, zu denen es auch eine Route gibt —
 * ein reiner Sonderfall an dieser Stelle liefe deshalb ins Leere.
 */
const AUTH_PREFIX = '/auth/'

export const onRequest = defineMiddleware(async (context, next) => {
	// In Tests komplett ohne Auth arbeiten
	if (process.env.DISABLE_AUTH === 'true') {
		return next()
	}

	const url = new URL(context.request.url)
	const path = url.pathname

	if (publicPaths.some((p) => path.startsWith(p))) {
		return next()
	}

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
			// Die Sitzung wurde gerade beim IdP verlängert — ohne dieses Cookie
			// an der ausgelieferten Antwort würde bei JEDER Anfrage erneut ein
			// Refresh laufen.
			pageResponse.headers.append('Set-Cookie', setCookie)
		}
		return pageResponse
	} catch (error) {
		if (error instanceof GrantsUnavailableError) {
			// Die Berechtigung wird bei jeder Anfrage frisch bei ZITADEL erfragt
			// (src/server/auth/grants.ts). Antwortet ZITADEL nicht, wird
			// VERWEIGERT statt durchgewunken — es laeuft im selben Cluster, ist
			// es weg, ist das ein Ausfall und kein Normalfall.
			return new Response(
				'Die Berechtigungspruefung ist gerade nicht erreichbar. Bitte spaeter erneut versuchen.',
				{
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' },
				},
			)
		}
		if (
			error instanceof OidcConfigError ||
			error instanceof GrantsConfigError
		) {
			// Fehlende Konfiguration ist ein Betriebsfehler, kein Nutzerfehler.
			// Bewusst 503 mit klarem Text statt eines Absturzes: der
			// CI-Smoke-Test startet das Image ohne Secrets und prüft, DASS der
			// Server antwortet — der Kalender oben ist da längst durch.
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
