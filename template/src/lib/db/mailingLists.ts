import type { Database } from 'better-sqlite3'
import { expandToSubtrees, getGroup } from './groups.js'
import { openDb } from './index.js'
import type {
	MailingListInput,
	MailingListRow,
	MitgliedRow,
	PosterPolicy,
} from './types.js'

/** Normalisiert eine E-Mail-Adresse fuer Vergleiche (trim + lowercase). */
export const normalizeEmail = (email: string): string =>
	email.trim().toLowerCase()

/** Parst ein JSON-String-Array robust (z.B. `recipient_groups`). */
const parseStringArray = (raw: string): string[] => {
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed.filter((v): v is string => typeof v === 'string')
	} catch {
		return []
	}
}

/** Parst ein JSON-Array von E-Mail-Adressen (lowercased, ohne Leereintraege). */
const parseEmailArray = (raw: string): string[] =>
	parseStringArray(raw)
		.map(normalizeEmail)
		.filter((v) => v.length > 0)

/** Dedupliziert E-Mail-Adressen (lowercased), Reihenfolge bleibt erhalten. */
const dedupeEmails = (emails: string[]): string[] => [
	...new Set(emails.map(normalizeEmail).filter((v) => v.length > 0)),
]

/**
 * Normalisiert ein Absender-Muster: trim + lowercase. Leere Eintraege fallen
 * weg, damit ein versehentliches Komma nicht zu einem Muster wird, das nichts
 * oder — schlimmer — alles trifft.
 */
const dedupePatterns = (patterns: string[]): string[] => [
	...new Set(patterns.map((p) => p.trim().toLowerCase()).filter(Boolean)),
]

/**
 * Trifft `email` das Muster `pattern`?
 *
 * Zwei Formen:
 *   `anna@example.org`   genau diese Adresse
 *   `*@schule.example`   jede Adresse dieser Domain
 *
 * Der Platzhalter steht NUR ganz vorne und ersetzt NUR den lokalen Teil. Ein
 * Muster `*@domain.tld` trifft deshalb `anna@domain.tld`, aber NICHT
 * `anna@sub.domain.tld` — sonst waere die Freigabe einer Schuldomain zugleich
 * die Freigabe jeder Subdomain, die irgendwer darunter anlegen kann.
 *
 * Verglichen wird case-insensitiv. Aufgerufen wird das mit dem ENVELOPE-
 * Absender, nicht mit dem `From:`-Header (siehe `src/lib/lists/incoming.ts`).
 */
export const matchesSenderPattern = (
	email: string,
	pattern: string,
): boolean => {
	const address = normalizeEmail(email)
	const pat = pattern.trim().toLowerCase()
	if (!pat || !address.includes('@')) return false
	if (pat.startsWith('*@')) {
		const domain = pat.slice(2)
		if (!domain) return false
		return address.slice(address.lastIndexOf('@') + 1) === domain
	}
	return address === pat
}

/** Group-Keys der Empfaenger einer Liste. */
export const listRecipientGroups = (list: MailingListRow): string[] =>
	parseStringArray(list.recipient_groups)

/** Group-Keys der erlaubten Absender einer Liste. */
export const listPosterGroups = (list: MailingListRow): string[] =>
	parseStringArray(list.poster_groups)

/** Erlaubte Absender-Muster einer Liste (Adressen und `*@domain`-Muster). */
export const listSenderPatterns = (list: MailingListRow): string[] =>
	dedupePatterns(parseStringArray(list.sender_patterns))

/**
 * Ein aufgeloester Listen-Empfaenger: entweder eine Person aus dem Adressbuch
 * (mit `mitglied_id`) oder eine reine Einzeladresse aus `extra_recipients`
 * (`mitglied_id: null`).
 */
export type ListRecipient = {
	email: string
	mitglied_id: string | null
	name: string | null
}

export const listMailingLists = (db: Database = openDb()): MailingListRow[] =>
	db
		.prepare<[], MailingListRow>('SELECT * FROM mailing_lists ORDER BY address')
		.all()

export const getMailingList = (
	address: string,
	db: Database = openDb(),
): MailingListRow | undefined =>
	db
		.prepare<[string], MailingListRow>(
			'SELECT * FROM mailing_lists WHERE address = ?',
		)
		.get(normalizeEmail(address))

/** Wirft, wenn ein referenzierter Group-Key nicht in `groups` existiert. */
const assertGroupExists = (key: string, db: Database): void => {
	if (!getGroup(key, db)) {
		throw new Error(
			`Unbekannte Gruppe "${key}". list_groups zeigt vorhandene Gruppen.`,
		)
	}
}

/**
 * Legt eine Liste an oder aktualisiert sie. Validiert alle recipient_groups
 * und poster_groups gegen die `groups`-Whitelist, bevor etwas geschrieben
 * wird. Mindestens eine recipient_group ODER eine extra_recipients-Adresse
 * muss gesetzt sein — sonst haette die Liste nie Empfaenger.
 */
export const upsertMailingList = (
	input: MailingListInput,
	db: Database = openDb(),
): MailingListRow => {
	const address = normalizeEmail(input.address)
	const recipientGroups = [...new Set(input.recipient_groups ?? [])]
	const posterGroups = [...new Set(input.poster_groups ?? [])]
	const extraRecipients = dedupeEmails(input.extra_recipients ?? [])
	if (recipientGroups.length === 0 && extraRecipients.length === 0) {
		throw new Error(
			'Eine Liste braucht mindestens eine recipient_group oder eine extra_recipients-Adresse.',
		)
	}
	for (const key of recipientGroups) assertGroupExists(key, db)
	for (const key of posterGroups) assertGroupExists(key, db)

	db.prepare<{
		address: string
		label: string
		recipient_groups: string
		poster_groups: string
		sender_patterns: string
		poster_policy: string
		extra_recipients: string
		reply_mode: string
		subject_prefix: string | null
		broadcast: 0 | 1
		aktiv: 0 | 1
	}>(
		`INSERT INTO mailing_lists (
       address, label, recipient_groups, poster_groups, sender_patterns,
       poster_policy, extra_recipients, reply_mode, subject_prefix, broadcast,
       aktiv
     ) VALUES (
       @address, @label, @recipient_groups, @poster_groups, @sender_patterns,
       @poster_policy, @extra_recipients, @reply_mode, @subject_prefix,
       @broadcast, @aktiv
     )
     ON CONFLICT(address) DO UPDATE SET
       label = excluded.label,
       recipient_groups = excluded.recipient_groups,
       poster_groups = excluded.poster_groups,
       sender_patterns = excluded.sender_patterns,
       poster_policy = excluded.poster_policy,
       extra_recipients = excluded.extra_recipients,
       reply_mode = excluded.reply_mode,
       subject_prefix = excluded.subject_prefix,
       broadcast = excluded.broadcast,
       aktiv = excluded.aktiv`,
	).run({
		address,
		label: input.label,
		recipient_groups: JSON.stringify(recipientGroups),
		poster_groups: JSON.stringify(posterGroups),
		sender_patterns: JSON.stringify(
			dedupePatterns(input.sender_patterns ?? []),
		),
		// Vorgabe `offen`: Ein Verteiler, der nur Eingeweihte durchlaesst,
		// verliert genau die Post, auf die es ankommt.
		poster_policy: input.poster_policy ?? 'offen',
		extra_recipients: JSON.stringify(extraRecipients),
		reply_mode: input.reply_mode ?? 'sender',
		subject_prefix: input.subject_prefix ?? null,
		broadcast: input.broadcast === true ? 1 : 0,
		aktiv: input.aktiv === false ? 0 : 1,
	})

	const row = getMailingList(address, db)
	if (!row) {
		throw new Error(
			`upsertMailingList: Zeile ${address} nach INSERT verschwunden`,
		)
	}
	return row
}

export const deleteMailingList = (
	address: string,
	db: Database = openDb(),
): boolean =>
	db
		.prepare<[string]>('DELETE FROM mailing_lists WHERE address = ?')
		.run(normalizeEmail(address)).changes > 0

/**
 * Setzt NUR die Absender-Richtlinie einer Liste — ohne Empfaenger, Antwortweg
 * oder sonst etwas anzufassen.
 *
 * Eigene Funktion und kein `upsertMailingList`-Aufruf, weil die Verwaltungs-
 * seite genau diese eine Frage stellt. Ueber den vollen Upsert zu gehen hiesse,
 * dort saemtliche uebrigen Felder mitzuschicken — und ein vergessenes Feld
 * waere dann ein stiller Datenverlust an einer Liste, die gerade laeuft.
 */
export const setListPosterPolicy = (
	address: string,
	policy: PosterPolicy,
	patterns: string[],
	db: Database = openDb(),
): MailingListRow => {
	const key = normalizeEmail(address)
	const list = getMailingList(key, db)
	if (!list) throw new Error(`Unbekannte Liste "${address}".`)
	db.prepare<[string, string, string]>(
		'UPDATE mailing_lists SET poster_policy = ?, sender_patterns = ? WHERE address = ?',
	).run(policy, JSON.stringify(dedupePatterns(patterns)), key)
	const row = getMailingList(key, db)
	if (!row) throw new Error(`Liste ${key} nach dem Update verschwunden`)
	return row
}

/**
 * Die Menge der namentlich erlaubten Absender-Adressen einer Liste
 * (lowercased): E-Mail-Adressen aller Personen ALLER `poster_groups`
 * (EFFEKTIV, also inkl. Untergruppen). Ist `broadcast` gesetzt, kommen alle
 * aufgeloesten Empfaenger dazu.
 *
 * Die `sender_patterns` stehen bewusst NICHT hier drin: ein Muster wie
 * `*@schule.example` laesst sich nicht zu einer Menge von Adressen ausrollen.
 * Es wird in `isSenderAllowed` direkt geprueft.
 *
 * ACHTUNG: Diese Funktion beantwortet nicht die Frage "darf jemand posten?" —
 * das tut `isSenderAllowed`, und bei `poster_policy = 'offen'` faellt diese
 * Menge dort gar nicht ins Gewicht.
 */
export const resolveAllowedSenders = (
	list: MailingListRow,
	db: Database = openDb(),
): Set<string> => {
	const allowed = new Set<string>()
	// Auch die Absender-Gruppen werden effektiv aufgeloest — sonst duerfte die
	// Untergruppe einer berechtigten Obergruppe ueberraschenderweise nicht
	// posten.
	const groups = expandToSubtrees(listPosterGroups(list), db)
	if (groups.length > 0) {
		const placeholders = groups.map(() => '?').join(', ')
		const rows = db
			.prepare<string[], { email: string | null }>(
				`SELECT DISTINCT m.email FROM mitglieder m
           JOIN group_memberships gm ON gm.mitglied_id = m.id
          WHERE gm.group_key IN (${placeholders})
            AND m.email IS NOT NULL AND m.email != ''`,
			)
			.all(...groups)
		for (const r of rows) {
			if (r.email) allowed.add(normalizeEmail(r.email))
		}
	}
	if (list.broadcast === 1) {
		for (const r of resolveListRecipients(list, db)) {
			allowed.add(normalizeEmail(r.email))
		}
	}
	return allowed
}

/**
 * Darf `fromEmail` in diese Liste posten?
 *
 * Bei `poster_policy = 'offen'` (Vorgabe) immer — mehr als eine syntaktisch
 * brauchbare Adresse wird nicht verlangt. Das ist die bewusste Entscheidung:
 * Ein Klassenverteiler soll vom Schulbuero, von der Musiklehrerin und vom
 * Elternteil an der Arbeitsadresse erreichbar sein, ohne dass jemand vorher
 * eine Liste pflegt.
 *
 * Bei `eingeschraenkt` genuegt EINE der beiden Quellen:
 *   - eine Adresse aus den `poster_groups` (bzw. bei `broadcast` aus den
 *     Empfaengern), oder
 *   - ein Treffer in den `sender_patterns` (Adresse oder `*@domain`).
 *
 * `fromEmail` ist der ENVELOPE-Absender. Der `From:`-Header ist freier Text
 * und darf hier nie die Grundlage sein.
 */
export const isSenderAllowed = (
	list: MailingListRow,
	fromEmail: string,
	db: Database = openDb(),
): boolean => {
	const address = normalizeEmail(fromEmail)
	if (!address.includes('@')) return false
	if (list.poster_policy === 'offen') return true
	if (
		listSenderPatterns(list).some((pattern) =>
			matchesSenderPattern(address, pattern),
		)
	) {
		return true
	}
	return resolveAllowedSenders(list, db).has(address)
}

/**
 * Die tatsaechlichen Empfaenger einer Liste:
 *   Personen ALLER `recipient_groups` (EFFEKTIV, inkl. Untergruppen) mit
 *   E-Mail-Adresse
 *   MINUS alle, die fuer diese Liste oder global (`*`) einen Opt-out haben
 *         (`list_suppressions`, personengebunden)
 *   PLUS  die `extra_recipients`-Einzeladressen
 *   MINUS alle Adressen, die fuer diese Liste oder global gesperrt sind
 *         (`address_suppressions` — Bounces, Beschwerden, adressgebundene
 *         Opt-outs; greift auch fuer Adressen ohne Adressbuch-Eintrag)
 * Ueber alle Quellen hinweg nach E-Mail-Adresse dedupliziert.
 */
/**
 * Sicherheitsventil fuer die Erprobung: Wenn `LIST_RECIPIENT_ALLOWLIST`
 * gesetzt ist, bekommt NUR Post, wessen Adresse darin steht (kommagetrennt,
 * Vergleich case-insensitiv; ein fuehrendes `@domain` erlaubt eine ganze
 * Domain).
 *
 * Warum es das gibt: Seit die Empfaenger aus den ZITADEL-Grants abgeleitet
 * werden, stehen dort echte Elternadressen — 55 in dieser Klasse. Ein
 * versehentlicher Versand waehrend der Erprobung waere nicht
 * zurueckzuholen, und die Eltern wissen von ihren Konten noch nichts. Die
 * Liste zu deaktivieren schuetzt nur, solange niemand sie aktiviert; diese
 * Schranke greift unabhaengig davon.
 *
 * Ist die Variable NICHT gesetzt, gilt sie nicht — der Normalbetrieb
 * verteilt an alle. Sie zu entfernen ist damit der bewusste Schritt in den
 * Echtbetrieb, und er steht an einer Stelle im Deployment.
 */
const allowlist = (): string[] =>
	(process.env.LIST_RECIPIENT_ALLOWLIST ?? '')
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean)

const allowed = (email: string, patterns: string[]): boolean =>
	patterns.length === 0 ||
	patterns.some((pattern) =>
		pattern.startsWith('@') ? email.endsWith(pattern) : email === pattern,
	)

export const resolveListRecipients = (
	list: MailingListRow,
	db: Database = openDb(),
): ListRecipient[] => {
	const byEmail = new Map<string, ListRecipient>()

	const groups = expandToSubtrees(listRecipientGroups(list), db)
	if (groups.length > 0) {
		const placeholders = groups.map(() => '?').join(', ')
		const rows = db
			.prepare<string[], MitgliedRow>(
				`SELECT DISTINCT m.* FROM mitglieder m
           JOIN group_memberships gm ON gm.mitglied_id = m.id
          WHERE gm.group_key IN (${placeholders})
            AND m.email IS NOT NULL AND m.email != ''
            AND NOT EXISTS (
              SELECT 1 FROM list_suppressions s
               WHERE s.mitglied_id = m.id
                 AND s.list_address IN (?, '*')
            )
          ORDER BY m.last_name, m.first_name`,
			)
			.all(...groups, list.address)
		for (const m of rows) {
			const key = normalizeEmail(m.email as string)
			if (!byEmail.has(key)) {
				byEmail.set(key, {
					email: m.email as string,
					mitglied_id: m.id,
					name: `${m.first_name} ${m.last_name}`,
				})
			}
		}
	}

	for (const email of parseEmailArray(list.extra_recipients)) {
		if (!byEmail.has(email)) {
			byEmail.set(email, { email, mitglied_id: null, name: null })
		}
	}

	// Adressgebundene Sperren zum Schluss anwenden: sie gelten unabhaengig
	// davon, ob die Adresse aus einer Gruppe oder aus extra_recipients kam.
	const blocked = new Set(
		db
			.prepare<[string], { email: string }>(
				"SELECT email FROM address_suppressions WHERE list_address IN (?, '*')",
			)
			.all(list.address)
			.map((r) => r.email),
	)
	for (const key of [...byEmail.keys()]) {
		if (blocked.has(key)) byEmail.delete(key)
	}

	const patterns = allowlist()
	if (patterns.length > 0) {
		for (const key of [...byEmail.keys()]) {
			if (!allowed(key, patterns)) byEmail.delete(key)
		}
	}

	return [...byEmail.values()]
}
