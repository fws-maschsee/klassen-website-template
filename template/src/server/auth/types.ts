export type AuthenticatedUser = {
	id: string
	email: string
	name?: string
	roles: string[]
}

export type AuthResult =
	| { ok: true; user: AuthenticatedUser }
	| { ok: false; reason: 'unauthenticated' | 'unauthorized' }

export interface AuthProvider {
	readonly name: string
	verifyRequest(request: Request): Promise<AuthResult>
}
