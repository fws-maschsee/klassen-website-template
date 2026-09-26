import type { APIRoute } from 'astro'
import { handleCallback } from '../../server/auth/oidc.js'

// Echte Route nötig: im middleware-Modus hinter Express ruft Astro die Middleware nur für existierende Routen auf.
export const GET: APIRoute = ({ request }) => handleCallback(request)
