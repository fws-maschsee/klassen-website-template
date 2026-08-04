import type { APIRoute } from 'astro'
import { handleCallback } from '../../server/auth/oidc.js'

/**
 * Rücksprung von ZITADEL: Code gegen Token tauschen, Sitzungs-Cookie setzen.
 *
 * Bewusst eine echte Route und nicht nur ein Sonderfall in der Middleware:
 * Der Node-Adapter läuft hier im `middleware`-Modus hinter Express, und dort
 * ruft Astro seine Middleware NUR für Pfade auf, zu denen es auch eine Route
 * gibt. Ohne diese Datei beantwortet Express `/auth/callback` mit „Cannot GET"
 * — die Anmeldung bricht genau im letzten Schritt ab, nachdem der Nutzer sein
 * Passwort schon eingegeben hat.
 */
export const GET: APIRoute = ({ request }) => handleCallback(request)
