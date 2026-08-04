import type { APIRoute } from 'astro'
import { handleLogout } from '../../server/auth/oidc.js'

/**
 * Abmelden: Sitzungs-Cookie löschen und die Sitzung auch beim IdP beenden.
 *
 * GET und POST, weil die Abmelden-Seite ein Formular abschickt, ein direkter
 * Link aus der Navigation aber ebenso funktionieren soll.
 */
export const GET: APIRoute = ({ request }) => handleLogout(request)
export const POST: APIRoute = ({ request }) => handleLogout(request)
