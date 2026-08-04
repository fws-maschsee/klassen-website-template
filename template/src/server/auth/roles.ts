/**
 * Rollen und was sie duerfen — die EINZIGE Stelle, an der aus einem
 * Token-Claim eine Erlaubnis wird. Sie liegt in `src/server/auth/`, weil
 * genau das der Vertrag dieses Verzeichnisses ist: ausserhalb kennt niemand
 * Rollennamen (siehe `types.ts`).
 *
 * Die Rollen kommen als Projektrollen aus ZITADEL (Claim
 * `urn:zitadel:iam:org:project:roles`, siehe `oidc.ts`). Der Claim enthaelt
 * nur die Rollen des Projekts, zu dem der OIDC-Client dieser Instanz gehoert
 * — die Trennung der Klassen entsteht also durch die Projektzuordnung und
 * nicht durch einen Namen, den man verwechseln kann. `admin` in
 * `klasse-musterfrau` sperrt nichts in `klasse-nachbar` auf.
 *
 * Weboberflaeche und MCP-Server fragen DIESELBE Funktion. Ein Klick in der
 * Verwaltung und ein `upsert_mitglied` ueber MCP sind derselbe Zugriff auf
 * dieselbe Datei; zwei Kopien der Regel waeren zwei Kopien, die auseinander
 * laufen. Nur die Oberflaeche abzusichern hiesse, den Schutz mit drei Zeilen
 * umgehbar zu machen.
 */

/** Lesen und Empfangen: die Klassenseite sehen, auf Listen stehen. */
export const ROLE_MITGLIED = 'mitglied'

/** Pflegen und Senden: Mitglieder und Listen bearbeiten, an Listen senden. */
export const ROLE_ADMIN = 'admin'

/**
 * Was jemand tun will — feiner als die zwei Rollen, weil drei sehr
 * unterschiedliche Fragen dahinterstecken.
 *
 * `lesen`
 *   Die Seite sehen. Dazu gehoert ausdruecklich auch: **welche Verteiler es
 *   gibt und welche Gruppen sie erreichen.** Das ist die Frage, die jedes
 *   Elternteil vor dem Absenden beantwortet haben will — schreibe ich gerade
 *   an alle Eltern oder auch ans Kollegium? Sie zu beantworten braucht keine
 *   einzige fremde Adresse.
 *
 * `personen`
 *   Namen, E-Mail-Adressen, Telefonnummern, wer auf welcher Liste steht, wer
 *   was bekommen hat. Personenbezogen und deshalb NICHT jedermanns Sache,
 *   auch nicht innerhalb der Klasse: wer in einer Liste steht, geht die
 *   uebrigen Familien nichts an.
 *
 * `bearbeiten`
 *   Aendern und senden.
 *
 * `personen` und `bearbeiten` haengen heute beide an `admin`. Sie trotzdem zu
 * trennen kostet nichts und macht an jeder Aufrufstelle sichtbar, WARUM dort
 * geprueft wird — und eine spaetere Rolle "darf sehen, aber nicht aendern"
 * waere dann eine Zeile hier statt einer Suche durch zwanzig Dateien.
 */
export type Capability = 'lesen' | 'personen' | 'bearbeiten'

/**
 * Darf dieser Zugang das?
 *
 * `requiredRole` ist die per `OIDC_REQUIRED_ROLE` konfigurierte Leserolle
 * (Vorgabe `mitglied`, siehe `AUTH_ROLE` in `src/site.config.ts`).
 *
 * `admin` schliesst `lesen` ein, auch ohne zusaetzlichen `mitglied`-Grant:
 * wer verwalten darf, darf erst recht lesen. Sonst haengt der Zugang daran,
 * dass beim Grant beide Haken gesetzt wurden — eine Falle, die genau einmal
 * jemanden aussperrt.
 */
export const may = (
	roles: readonly string[],
	capability: Capability,
	requiredRole: string = ROLE_MITGLIED,
): boolean => {
	const admin = roles.includes(ROLE_ADMIN)
	if (capability === 'lesen') return admin || roles.includes(requiredRole)
	return admin
}

/** Kurzform fuer `may(roles, 'lesen')` — die Eintrittskarte zur Seite. */
export const canRead = (
	roles: readonly string[],
	requiredRole: string = ROLE_MITGLIED,
): boolean => may(roles, 'lesen', requiredRole)

/** Kurzform fuer `may(roles, 'personen')` — Namen und Adressen sehen. */
export const canSeePersonalData = (roles: readonly string[]): boolean =>
	may(roles, 'personen')

/** Kurzform fuer `may(roles, 'bearbeiten')`. */
export const canEdit = (roles: readonly string[]): boolean =>
	may(roles, 'bearbeiten')

/**
 * Begruendung fuer einen abgelehnten Zugriff. Bewusst identisch in
 * Weboberflaeche und MCP — wer sie liest, soll wissen, was ihm fehlt und wer
 * es geben kann. Und sie benennt den Unterschied, sonst klingt eine
 * abgelehnte Leseanfrage nach einem Fehler des Servers.
 */
export const deniedMessage = (capability: Capability): string => {
	const was =
		capability === 'personen'
			? 'Namen und Adressen der Familien zu sehen'
			: 'zu bearbeiten oder zu senden'
	return (
		`Dieser Zugang darf die Verteiler sehen, aber nicht ${was}. ` +
		`Dafuer braucht es die Rolle "${ROLE_ADMIN}" im ZITADEL-Projekt dieser Klasse. ` +
		'Die Klassenelternvertretung kann sie vergeben.'
	)
}

/** Der haeufigste Fall, als Konstante fuer Oberflaechentexte. */
export const EDIT_DENIED_MESSAGE = deniedMessage('bearbeiten')
