import type { APIRoute } from 'astro'
import { startLogin } from '../../server/auth/oidc.js'

/**
 * Anmeldung anstoßen. `?rd=/pfad` merkt sich, wohin es danach zurückgehen
 * soll. Siehe callback.ts, warum das eine echte Route ist.
 */
export const GET: APIRoute = ({ request, url }) =>
	startLogin(request, url.searchParams.get('rd') ?? '/')
