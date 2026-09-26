import type { APIRoute } from 'astro'
import { handleLogout } from '../../server/auth/oidc.js'

// GET und POST: die Abmelden-Seite schickt ein Formular, der Navigationslink ist ein GET.
export const GET: APIRoute = ({ request }) => handleLogout(request)
export const POST: APIRoute = ({ request }) => handleLogout(request)
