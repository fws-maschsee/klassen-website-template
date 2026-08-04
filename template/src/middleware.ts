import { defineMiddleware } from 'astro:middleware'
import { handleAuthRequest } from '@levino/pocketbase-auth'
import { AUTH_GROUP, AUTH_POCKETBASE_URL } from './site.config'

/**
 * Pfade, die ohne Anmeldung erreichbar bleiben.
 *
 * `/public/` enthält den Klassenkalender. Er MUSS frei erreichbar sein: Die
 * Kalender-Apps der Eltern rufen die .ics-Datei ohne Cookie ab. Steht sie
 * hinter dem Login, hören alle Abos still auf zu aktualisieren.
 */
const publicPaths = ['/public/']

export const onRequest = defineMiddleware(async (context, next) => {
	// In Tests komplett ohne Auth arbeiten (siehe playwright.config.ts).
	if (process.env.DISABLE_AUTH === 'true') {
		return next()
	}

	const path = new URL(context.request.url).pathname

	if (publicPaths.some((p) => path.startsWith(p))) {
		return next()
	}

	// handleAuthRequest behandelt /api/cookie, /api/logout und die Auth-Prüfung.
	const authResponse = await handleAuthRequest(context.request, {
		pocketbaseUrl: AUTH_POCKETBASE_URL,
		// AUTH_GROUP ist kein Anzeigename, sondern der Bezeichner der
		// Benutzergruppe im Auth-Backend. Er muss dort exakt so heißen. Siehe
		// die Begründung in src/site.config.ts.
		groupField: AUTH_GROUP,
	})

	if (authResponse) {
		return authResponse
	}

	return next()
})
