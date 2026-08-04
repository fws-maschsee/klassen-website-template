import { resolveSession } from './oidc.js'
import type { AuthProvider, AuthResult } from './types.js'

/**
 * ZITADEL-Implementierung der Auth-Abstraktion.
 *
 * Sie prüft nur ein bereits vorhandenes Sitzungs-Cookie — den eigentlichen
 * Anmeldevorgang (Umleitung zum IdP, Rückkehr auf `/auth/callback`) führt die
 * Astro-Middleware, weil er HTTP-Antworten braucht und nicht bloß ein Urteil.
 * Beide benutzen dieselbe Funktion `resolveSession`, damit die Seite und die
 * Mitgliederverwaltung nicht unterschiedlich urteilen können.
 *
 * Maßgeblich ist das ID-Token des zentralen ZITADEL (`OIDC_ISSUER`) und die
 * Rolle `mitglied` im ZITADEL-Projekt dieser Klasse. Ein früherer Stand dieses
 * Stacks prüfte stattdessen eine Benutzergruppe in PocketBase; davon ist
 * nichts übrig geblieben, und es gibt bewusst keinen Weg zurück.
 */
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
				// Der `sub` aus ZITADEL — der stabile Schlüssel, unter dem die
				// Fachdaten in der SQLite-Datei hängen. Er ist NICHT die frühere
				// PocketBase-ID; wer alte Verknüpfungen hat, muss sie umschlüsseln.
				id: outcome.session.sub,
				email: outcome.session.email,
				name: outcome.session.name || undefined,
				// Ob dieser Zugang nur lesen oder auch aendern darf, entscheidet
				// `roles.ts` — hier werden die Rollen nur weitergereicht.
				roles: outcome.session.roles,
			},
		}
	},
}
