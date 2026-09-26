import type { Database } from 'better-sqlite3'
import { expandToSubtrees, getGroup } from './groups.js'
import { openDb } from './index.js'
import type {
	MailingListInput,
	MailingListRow,
	MitgliedRow,
	PosterPolicy,
} from './types.js'

export const normalizeEmail = (email: string): string =>
	email.trim().toLowerCase()

const parseStringArray = (raw: string): string[] => {
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed.filter((v): v is string => typeof v === 'string')
	} catch {
		return []
	}
}

const parseEmailArray = (raw: string): string[] =>
	parseStringArray(raw)
		.map(normalizeEmail)
		.filter((v) => v.length > 0)

const dedupeEmails = (emails: string[]): string[] => [
	...new Set(emails.map(normalizeEmail).filter((v) => v.length > 0)),
]

export const listRecipientGroups = (list: MailingListRow): string[] =>
	parseStringArray(list.recipient_groups)

export const listPosterGroups = (list: MailingListRow): string[] =>
	parseStringArray(list.poster_groups)

export const listPosterPolicy = (list: MailingListRow): PosterPolicy =>
	// Unbekannte Werte gelten als eingeschränkt: im Zweifel die engere Auslegung.
	list.poster_policy === 'offen' ? 'offen' : 'eingeschraenkt'

export const listSenderPatterns = (list: MailingListRow): string[] =>
	parseEmailArray(list.sender_patterns)

const isDomainPattern = (pattern: string): boolean => pattern.startsWith('*@')

export const matchesSenderPattern = (
	email: string,
	pattern: string,
): boolean => {
	const address = normalizeEmail(email)
	const needle = normalizeEmail(pattern)
	if (!isDomainPattern(needle)) return address === needle
	const domain = needle.slice(2)
	if (domain === '') return false
	const at = address.lastIndexOf('@')
	// Domain exakt, keine Subdomains: sonst dürfte jede fremd kontrollierte Subdomain an die Elternliste schreiben.
	return at !== -1 && address.slice(at + 1) === domain
}

const DOMAIN_RE =
	/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/
const LOCAL_RE = /^[^@\s*]+$/

export const normalizeSenderPattern = (raw: string): string => {
	const pattern = normalizeEmail(raw)
	const hint =
		'Erlaubt sind eine volle Adresse (anna@example.org) oder ein Domain-Platzhalter (*@example.org).'
	if (isDomainPattern(pattern)) {
		if (!DOMAIN_RE.test(pattern.slice(2))) {
			throw new Error(`"${raw}" ist kein gueltiger Domain-Platzhalter. ${hint}`)
		}
		return pattern
	}
	const at = pattern.lastIndexOf('@')
	if (
		at < 1 ||
		!LOCAL_RE.test(pattern.slice(0, at)) ||
		!DOMAIN_RE.test(pattern.slice(at + 1))
	) {
		throw new Error(`"${raw}" ist kein gueltiges Absender-Muster. ${hint}`)
	}
	return pattern
}

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

const assertGroupExists = (key: string, db: Database): void => {
	if (!getGroup(key, db)) {
		throw new Error(
			`Unbekannte Gruppe "${key}". list_groups zeigt vorhandene Gruppen.`,
		)
	}
}

export const upsertMailingList = (
	input: MailingListInput,
	db: Database = openDb(),
): MailingListRow => {
	const address = normalizeEmail(input.address)
	const recipientGroups = [...new Set(input.recipient_groups ?? [])]
	const posterGroups = [...new Set(input.poster_groups ?? [])]
	const extraRecipients = dedupeEmails(input.extra_recipients ?? [])
	const senderPatterns = [
		// Vor dem Schreiben prüfen: ein Tippfehler soll beim Speichern auffallen, nicht erst als abgeprallte Mail.
		...new Set((input.sender_patterns ?? []).map(normalizeSenderPattern)),
	]
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
		poster_policy: string
		sender_patterns: string
		extra_recipients: string
		reply_mode: string
		subject_prefix: string | null
		broadcast: 0 | 1
		aktiv: 0 | 1
	}>(
		`INSERT INTO mailing_lists (
       address, label, recipient_groups, poster_groups, poster_policy,
       sender_patterns, extra_recipients, reply_mode, subject_prefix,
       broadcast, aktiv
     ) VALUES (
       @address, @label, @recipient_groups, @poster_groups, @poster_policy,
       @sender_patterns, @extra_recipients, @reply_mode, @subject_prefix,
       @broadcast, @aktiv
     )
     ON CONFLICT(address) DO UPDATE SET
       label = excluded.label,
       recipient_groups = excluded.recipient_groups,
       poster_groups = excluded.poster_groups,
       poster_policy = excluded.poster_policy,
       sender_patterns = excluded.sender_patterns,
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
		// Vorgabe 'offen' für neue Listen ist eine Entscheidung des Betreibers.
		poster_policy: input.poster_policy ?? 'offen',
		sender_patterns: JSON.stringify(senderPatterns),
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

export const resolveAllowedSenders = (
	list: MailingListRow,
	db: Database = openDb(),
): Set<string> => {
	const allowed = new Set<string>(
		listSenderPatterns(list).filter((p) => !isDomainPattern(p)),
	)
	// Effektiv aufgelöst, sonst dürfte die Untergruppe einer berechtigten Gruppe nicht posten.
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

export const isSenderAllowed = (
	list: MailingListRow,
	fromEmail: string,
	db: Database = openDb(),
): boolean => {
	if (listPosterPolicy(list) === 'offen') return true
	const email = normalizeEmail(fromEmail)
	if (email === '') return false
	if (resolveAllowedSenders(list, db).has(email)) return true
	return listSenderPatterns(list)
		.filter(isDomainPattern)
		.some((pattern) => matchesSenderPattern(email, pattern))
}

export const setListPosterRules = (
	address: string,
	policy: PosterPolicy,
	patterns: string[],
	db: Database = openDb(),
): MailingListRow => {
	const key = normalizeEmail(address)
	if (!getMailingList(key, db)) {
		throw new Error(`Unbekannte Liste "${address}".`)
	}
	const cleaned = [...new Set(patterns.map(normalizeSenderPattern))]
	db.prepare<[string, string, string]>(
		'UPDATE mailing_lists SET poster_policy = ?, sender_patterns = ? WHERE address = ?',
	).run(policy, JSON.stringify(cleaned), key)
	const row = getMailingList(key, db)
	if (!row) throw new Error(`setListPosterRules: Zeile ${key} verschwunden`)
	return row
}

// Sicherheitsventil für die Erprobung: gesetzt, bekommen nur diese Adressen Post; Entfernen ist der Schritt in den Echtbetrieb.
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
				// Spalten statt m.*: zitadel_user_id ist intern und darf nicht nebenbei mitkommen.
				`SELECT DISTINCT m.id, m.first_name, m.last_name, m.email,
                m.created_at, m.updated_at
           FROM mitglieder m
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

	// Adress-Sperren zuletzt: sie gelten auch für Adressen aus extra_recipients.
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
