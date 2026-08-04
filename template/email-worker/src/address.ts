/**
 * Zerlegt die Empfängeradresse einer Klassen-Mailingliste.
 *
 * Schema:  <liste>@<klasse>.lists.example.org
 * Beispiel: eltern@klasse-musterfrau.lists.example.org
 *
 * Dieser Worker gehört zu genau EINER Klasse (`expectedClass`). Der Klassenteil
 * der Adresse wird deshalb nicht nur gelesen, sondern geprüft: Kommt hier Post
 * für eine andere Klasse an, wird sie abgewiesen und NICHT an die eigene App
 * weitergereicht.
 *
 * Das ist der sicherheitsrelevante Teil dieser Datei. Ohne diese Prüfung würde
 * eine falsch gesetzte Cloudflare-Regel genügen, damit Elternpost der einen
 * Klasse bei der anderen landet — ein Datenschutzvorfall, kein Betriebsfehler.
 * Alles, was nicht exakt ins Schema passt, muss deshalb definiert scheitern
 * statt „irgendwie" zu greifen.
 */

export type ParsedRecipient = {
	/** Listen-Localpart, z.B. `eltern`. */
	list: string
	/** Klassen-Label aus der Subdomain, z.B. `klasse-musterfrau`. */
	class: string
	/** Vollständige, normalisierte Envelope-Empfängeradresse. */
	recipient: string
	/** Plus-Suffix des Localparts (`eltern+foo` -> `foo`), sonst `null`. */
	tag: string | null
}

export type ParseResult =
	| { ok: true; value: ParsedRecipient }
	| { ok: false; reason: string }

/**
 * Erlaubte Form für Klassen- und Listen-Label: Kleinbuchstaben, Ziffern,
 * einzelne Bindestriche als Trenner. Bewusst streng — beide Werte landen in
 * HTTP-Headern und in der Reject-Meldung an den Absender, und was hier
 * durchkommt, kann dort keine Steuerzeichen einschleusen.
 */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const isSlug = (value: string): boolean => SLUG.test(value)

/** Erlaubte Zeichen im Plus-Suffix. Es wird nur durchgereicht, nie ausgewertet. */
const TAG = /^[a-z0-9._-]+$/

/** DNS-Label-Grenze; längere Klassen-Subdomains kann es gar nicht geben. */
const MAX_LABEL_LENGTH = 63

/** RFC 5321 begrenzt den Localpart auf 64 Zeichen. */
const MAX_LOCALPART_LENGTH = 64

export const parseListRecipient = (
	rcptTo: string,
	listDomain: string,
	expectedClass: string,
): ParseResult => {
	const address = rcptTo.trim().toLowerCase()
	const suffix = `.${listDomain
		.trim()
		.toLowerCase()
		.replace(/^\.|\.$/g, '')}`

	const at = address.lastIndexOf('@')
	if (at <= 0 || at === address.length - 1) {
		return { ok: false, reason: 'keine gültige E-Mail-Adresse' }
	}

	const localpart = address.slice(0, at)
	const domain = address.slice(at + 1)

	if (!domain.endsWith(suffix)) {
		return { ok: false, reason: `Domain gehört nicht zu ${suffix.slice(1)}` }
	}

	// Genau ein Label zwischen Localpart und Listen-Domain. `SLUG` verbietet
	// Punkte und damit auch tiefer verschachtelte Subdomains, und es verbietet
	// die leere Zeichenkette: `eltern@lists.example.org` (ohne Klasse)
	// fällt hier durch.
	const classSlug = domain.slice(0, -suffix.length)
	if (!isSlug(classSlug) || classSlug.length > MAX_LABEL_LENGTH) {
		return { ok: false, reason: 'kein gültiges Klassen-Label in der Domain' }
	}

	// Der Kern: fremde Klasse -> nicht zuständig, also auch nicht weiterreichen.
	if (classSlug !== expectedClass) {
		return {
			ok: false,
			reason: `Adresse gehört zu ${classSlug}, dieser Verteiler bedient ${expectedClass}`,
		}
	}

	if (localpart.length > MAX_LOCALPART_LENGTH) {
		return { ok: false, reason: 'Localpart zu lang' }
	}
	// Ein zweites @ ist ohne Anführungszeichen nicht zulässig. Ohne diese Prüfung
	// würde `eltern+@irgendwas@klasse-musterfrau.…` als Liste `eltern` durchgehen.
	if (localpart.includes('@')) {
		return { ok: false, reason: 'mehrere @ in der Adresse' }
	}

	// Plus-Adressierung abschneiden, damit `eltern+beliebig@…` nicht als eigene,
	// unbekannte Liste durchgeht — und umgekehrt keine Prüfung umgeht.
	const plus = localpart.indexOf('+')
	const list = plus === -1 ? localpart : localpart.slice(0, plus)
	const tag = plus === -1 ? null : localpart.slice(plus + 1) || null

	if (!isSlug(list)) {
		return { ok: false, reason: 'kein gültiger Listenname' }
	}
	if (tag !== null && !TAG.test(tag)) {
		return { ok: false, reason: 'kein gültiges Suffix nach dem Plus' }
	}

	return {
		ok: true,
		value: { list, class: classSlug, recipient: address, tag },
	}
}
