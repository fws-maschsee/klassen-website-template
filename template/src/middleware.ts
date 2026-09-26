import { defineMiddleware } from 'astro:middleware'
import {
	GrantsConfigError,
	GrantsUnavailableError,
} from './server/auth/grants.js'
import { authenticate, OidcConfigError } from './server/auth/oidc.js'
import { CALENDAR_PATH, CLASS_NAME, CONTACT_MAIL } from './site.config'

const publicPaths = ['/public/', '/api/lists/']

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
			pageResponse.headers.append('Set-Cookie', setCookie)
		}
		return pageResponse
	} catch (error) {
		if (error instanceof GrantsUnavailableError) {
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
