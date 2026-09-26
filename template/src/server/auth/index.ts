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

export const verifyRequest = (request: Request): Promise<AuthResult> =>
	authProvider().verifyRequest(request)

export const verifyCookieHeader = (
	cookieHeader: string | undefined,
): Promise<AuthResult> => {
	const headers = new Headers()
	if (cookieHeader) headers.set('cookie', cookieHeader)
	return authProvider().verifyRequest(
		new Request('http://localhost/', { headers }),
	)
}
