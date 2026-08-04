/**
 * Auth-Abstraktion. EINZIGE Stelle, an der die Anwendung ueber Anmeldung
 * spricht.
 *
 * Dahinter steckt ZITADEL (`zitadel.ts`, Motor in `oidc.ts`). Der Wechsel von
 * PocketBase hierher hat genau dieses Verzeichnis angefasst — die Abstraktion
 * hat gehalten. Damit das so bleibt, gilt weiter:
 *
 *   - Kein Modul ausserhalb von `src/server/auth/` kennt den
 *     Identity-Provider, Rollen- oder Gruppennamen.
 *   - Alles fragt ueber `verifyRequest`/`verifyCookieHeader` aus `index.ts`.
 *   - Ein neuer Provider implementiert `AuthProvider` und wird in `index.ts`
 *     eingehaengt. Sonst aendert sich nichts.
 *
 * Eine Grenze hat die Abstraktion: sie urteilt nur ueber ein vorhandenes
 * Cookie. Der Anmeldevorgang selbst (Umleitung zum IdP, Rueckkehr auf
 * `/auth/callback`) braucht HTTP-Antworten und liegt deshalb in
 * `src/middleware.ts` — die aber dieselbe `resolveSession` benutzt.
 */

export type AuthenticatedUser = {
	/** Stabile Nutzer-ID des Identity-Providers. Landet in den OAuth-Tokens. */
	id: string
	email: string
	name?: string
	/**
	 * Projektrollen aus dem Token (`mitglied`, `admin`). Nie `undefined` —
	 * eine fehlende Liste waere sonst schnell mal "alles erlaubt". Was sie
	 * bedeuten, steht ausschliesslich in `roles.ts`; ausserhalb dieses
	 * Verzeichnisses fragt niemand nach einem Rollennamen, sondern nach
	 * `canEdit(...)`.
	 */
	roles: string[]
}

export type AuthResult =
	| { ok: true; user: AuthenticatedUser }
	| { ok: false; reason: 'unauthenticated' | 'unauthorized' }

export interface AuthProvider {
	/** Kurzname fuer Logs und `get_instance_info`, z.B. `zitadel`. */
	readonly name: string
	/**
	 * Prueft einen eingehenden Request (Cookie-basiert). Liefert
	 * `unauthenticated`, wenn niemand angemeldet ist, und `unauthorized`, wenn
	 * jemand angemeldet ist, aber nicht zur Klasse gehoert.
	 */
	verifyRequest(request: Request): Promise<AuthResult>
}
