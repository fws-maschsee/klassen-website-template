import type { AuthProvider, AuthResult } from './types.js'
import { zitadelAuthProvider } from './zitadel.js'

export {
	canEdit,
	canRead,
	EDIT_DENIED_MESSAGE,
	ROLE_ADMIN,
	ROLE_MITGLIED,
} from './roles.js'
export type { AuthenticatedUser, AuthProvider, AuthResult } from './types.js'

/**
 * Der aktive Auth-Provider. Hier — und nur hier — wird er ausgetauscht; alles
 * andere im Projekt spricht ausschliesslich ueber `verifyRequest` /
 * `verifyCookieHeader`.
 *
 * Der frueher hier eingehaengte PocketBase-Provider ist ersatzlos entfallen.
 * Ihn als abschaltbare Alternative stehenzulassen haette bedeutet, einen Weg
 * zurueck anzubieten, den niemand mehr gehen kann.
 */
const providers: Record<string, AuthProvider> = {
	zitadel: zitadelAuthProvider,
}

export const authProvider = (): AuthProvider => {
	const name = process.env.AUTH_PROVIDER?.trim() || 'zitadel'
	const provider = providers[name]
	if (!provider) {
		throw new Error(
			`Unbekannter AUTH_PROVIDER "${name}". Verfuegbar: ${Object.keys(providers).join(', ')}`,
		)
	}
	return provider
}

/** Prueft einen Fetch-Request (Astro-Seiten, API-Routen). */
export const verifyRequest = (request: Request): Promise<AuthResult> =>
	authProvider().verifyRequest(request)

/**
 * Prueft einen rohen Cookie-Header (Express-Middleware). Baut sich intern den
 * minimal noetigen Request, damit die Provider nur EINE Methode brauchen.
 */
export const verifyCookieHeader = (
	cookieHeader: string | undefined,
): Promise<AuthResult> => {
	const headers = new Headers()
	if (cookieHeader) headers.set('cookie', cookieHeader)
	return authProvider().verifyRequest(
		new Request('http://localhost/', { headers }),
	)
}
