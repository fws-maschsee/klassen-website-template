import { resolveSession } from './oidc.js'
import type { AuthProvider, AuthResult } from './types.js'

export const zitadelAuthProvider: AuthProvider = {
	name: 'zitadel',

	async verifyRequest(request: Request): Promise<AuthResult> {
		const outcome = await resolveSession(request)

		if (outcome.state === 'unauthenticated' || !outcome.session) {
			return { ok: false, reason: 'unauthenticated' }
		}
		if (outcome.state === 'unauthorized') {
			return { ok: false, reason: 'unauthorized' }
		}
		return {
			ok: true,
			user: {
				id: outcome.session.sub,
				email: outcome.session.email,
				name: outcome.session.name || undefined,
				roles: outcome.session.roles,
			},
		}
	},
}
