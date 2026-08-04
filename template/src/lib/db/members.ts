import type { Database } from 'better-sqlite3'
import { openDb } from './index.js'
import type { MitgliedInput, MitgliedRow } from './types.js'

/** System-Group: die Elternschaft der Klasse (siehe Migration `create_groups`). */
export const GROUP_ELTERN = 'eltern'

/**
 * Die Spalten, die das Adressbuch nach aussen zeigt. Bewusst aufgezaehlt statt
 * `SELECT *`: `zitadel_user_id` ist eine INTERNE Verknuepfung zur Anmeldung
 * (siehe src/server/auth/mirror.ts) und hat weder in der Oberflaeche noch in
 * einer MCP-Ausgabe etwas zu suchen. Wer sie braucht, holt sie sich dort, wo
 * sie hingehoert — nicht hier nebenbei mit.
 */
const COLUMNS = 'id, first_name, last_name, email, created_at, updated_at'

/** Dieselben Spalten mit Tabellen-Alias, fuer Abfragen mit JOIN. */
const cols = (alias: string): string =>
	COLUMNS.split(', ')
		.map((c) => `${alias}.${c}`)
		.join(', ')

/**
 * Leitet den Schluessel aus dem Namen ab (`vorname-nachname`). Diese Regel
 * ist die EINZIGE Stelle, an der ids entstehen — auch die Spiegelung aus
 * ZITADEL benutzt sie. `normalize('NFD')` traegt beliebige Diakritika ab,
 * nicht nur die deutschen Umlaute.
 */
export const slugify = (firstName: string, lastName: string): string =>
	`${firstName}-${lastName}`
		.toLowerCase()
		.replace(/ä/g, 'ae')
		.replace(/ö/g, 'oe')
		.replace(/ü/g, 'ue')
		.replace(/ß/g, 'ss')
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')

/**
 * Der aus dem Namen abgeleitete Schluessel — und falls der schon jemand
 * anderem gehoert, derselbe mit `-2`, `-3`, ... dahinter. Namensgleichheit ist
 * in einer Schulklasse moeglich (Geschwister, gleichnamige Eltern), deshalb
 * gibt es bewusst keinen UNIQUE-Index auf den Namen.
 *
 * Das loest die SCHLUESSEL-Kollision, nicht die Frage, ob dahinter zweimal
 * dieselbe Person steht — die muss ein Mensch beantworten.
 *
 * `keepId` bleibt frei: beim Umschluesseln einer bestehenden Zeile soll ihr
 * eigener alter Schluessel nicht als Kollision zaehlen.
 */
export const uniqueMemberId = (
	firstName: string,
	lastName: string,
	db: Database = openDb(),
	keepId?: string,
): string => {
	const base = slugify(firstName, lastName)
	// Voellig namenlos (z.B. leerer Profilname): dann bleibt nur etwas
	// Kuenstliches, das wenigstens stabil ist.
	const start = base === '' ? 'person' : base
	const taken = db.prepare<[string], { id: string }>(
		'SELECT id FROM mitglieder WHERE id = ?',
	)
	const frei = (candidate: string): boolean =>
		candidate === keepId || !taken.get(candidate)
	if (frei(start)) return start
	for (let n = 2; ; n++) {
		const candidate = `${start}-${n}`
		if (frei(candidate)) return candidate
	}
}

export const listMitglieder = (db: Database = openDb()): MitgliedRow[] =>
	db
		.prepare<[], MitgliedRow>(
			`SELECT ${COLUMNS} FROM mitglieder ORDER BY last_name, first_name`,
		)
		.all()

/**
 * Alle Personen, die DIREKT in einer Gruppe stehen. Wird von allen
 * SCHREIBENDEN Operationen und Diffs benutzt.
 */
export const listMitgliederByGroup = (
	groupKey: string,
	db: Database = openDb(),
): MitgliedRow[] =>
	db
		.prepare<[string], MitgliedRow>(
			`SELECT ${cols('m')} FROM mitglieder m
         JOIN group_memberships gm ON gm.mitglied_id = m.id
        WHERE gm.group_key = ?
        ORDER BY m.last_name, m.first_name`,
		)
		.all(groupKey)

/**
 * Alle Personen einer Gruppe EFFEKTIV: direkte Mitglieder PLUS alle Mitglieder
 * der (rekursiven) Kindgruppen, dedupliziert nach Person. Das ist die fuer
 * jeden VERTEILER relevante Menge — eine Obergruppe erreicht damit automatisch
 * alle, die in ihren Untergruppen stehen, ohne dass jemand doppelt gepflegt
 * werden muss. Ohne Kindgruppen identisch zu `listMitgliederByGroup`.
 * `UNION` (nicht `UNION ALL`) im CTE dedupliziert die Gruppen-Keys und
 * terminiert auch bei einem Zyklus in Altdaten.
 *
 * Bewusst getrennt von `listMitgliederByGroup`: SCHREIBENDE Operationen
 * (add/remove/set) arbeiten auf direkten Mitgliedschaften, LESENDE/aufloesende
 * auf der effektiven Menge.
 */
export const listMitgliederByGroupEffective = (
	groupKey: string,
	db: Database = openDb(),
): MitgliedRow[] =>
	db
		.prepare<[string], MitgliedRow>(
			`WITH RECURSIVE subtree(key) AS (
         SELECT ?
         UNION
         SELECT e.child_key FROM group_edges e
           JOIN subtree s ON e.parent_key = s.key
       )
       SELECT DISTINCT ${cols('m')} FROM mitglieder m
         JOIN group_memberships gm ON gm.mitglied_id = m.id
        WHERE gm.group_key IN (SELECT key FROM subtree)
        ORDER BY m.last_name, m.first_name`,
		)
		.all(groupKey)

/** Group-Keys, in denen die Person DIREKT ist (alphabetisch). */
export const getMitgliedGroups = (
	mitgliedId: string,
	db: Database = openDb(),
): string[] =>
	db
		.prepare<[string], { group_key: string }>(
			'SELECT group_key FROM group_memberships WHERE mitglied_id = ? ORDER BY group_key',
		)
		.all(mitgliedId)
		.map((r) => r.group_key)

export const getMitglied = (
	id: string,
	db: Database = openDb(),
): MitgliedRow | undefined =>
	db
		.prepare<[string], MitgliedRow>(
			`SELECT ${COLUMNS} FROM mitglieder WHERE id = ?`,
		)
		.get(id)

export const getMitgliederByIds = (
	ids: string[],
	db: Database = openDb(),
): MitgliedRow[] => {
	if (ids.length === 0) return []
	const placeholders = ids.map(() => '?').join(',')
	return db
		.prepare<string[], MitgliedRow>(
			`SELECT ${COLUMNS} FROM mitglieder WHERE id IN (${placeholders})`,
		)
		.all(...ids)
}

/**
 * Faltet Text fuer tolerante Suche: case-insensitiv und diakritik-insensitiv
 * (`Doss` findet `Doß`, `Muller` findet `Müller`).
 */
const foldText = (value: string): string =>
	value.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '')

export type MitgliederSearchFilter = {
	/** Freitext ueber first_name, last_name, email (Teilstring). */
	query?: string
	/** Nur Personen in dieser Group (Key), EFFEKTIV inkl. Untergruppen. */
	group?: string
	/** true = nur mit E-Mail, false = nur ohne. */
	has_email?: boolean
}

const isSet = (value: string | null): boolean =>
	value != null && value.trim() !== ''

/**
 * Tolerante Suche ueber das Adressbuch. Freitext matcht als
 * diakritik-insensitiver Teilstring ueber Name und E-Mail;
 * die optionalen Filter grenzen zusaetzlich ein. Die Datenmenge ist klein
 * (eine Schulklasse), daher wird in JS gefiltert — zuverlaessiger als
 * SQL-LIKE bei Diakritika.
 */
export const searchMitglieder = (
	filter: MitgliederSearchFilter,
	db: Database = openDb(),
): MitgliedRow[] => {
	// Gruppenfilter = EFFEKTIV: wer eine Obergruppe sucht, erwartet auch die
	// Personen ihrer Untergruppen.
	let rows = filter.group
		? listMitgliederByGroupEffective(filter.group, db)
		: listMitglieder(db)

	if (filter.has_email !== undefined) {
		rows = rows.filter((r) => isSet(r.email) === filter.has_email)
	}

	const query = filter.query?.trim()
	if (query) {
		const needle = foldText(query)
		rows = rows.filter((r) => {
			const haystack = foldText(
				[r.first_name, r.last_name, r.email]
					.filter((v): v is string => v != null)
					.join(' '),
			)
			return haystack.includes(needle)
		})
	}
	return rows
}

/**
 * Legt eine Person an oder aktualisiert sie. **Partielles Update:** Beim
 * Update werden NUR die tatsaechlich mitgeschickten Felder veraendert — ein
 * weggelassenes Feld (`undefined`) bleibt unveraendert, ein explizit als
 * `null` uebergebenes Feld wird geleert (JSON-Merge-Patch, RFC 7396). Beim
 * ersten Anlegen werden weggelassene optionale Felder mit `null` vorbelegt.
 * `groups`: `undefined` => unveraendert, `[]` => alle entfernen.
 */
export const upsertMitglied = (
	input: MitgliedInput,
	db: Database = openDb(),
): MitgliedRow => {
	const id = input.id ?? slugify(input.first_name, input.last_name)
	const existing = getMitglied(id, db)

	if (existing) {
		const sets: string[] = []
		const params: Record<string, string | number | null> = { id }
		const setField = (column: string, value: string | number | null): void => {
			sets.push(`${column} = @${column}`)
			params[column] = value
		}
		if (input.first_name !== undefined) setField('first_name', input.first_name)
		if (input.last_name !== undefined) setField('last_name', input.last_name)
		if (input.email !== undefined) setField('email', input.email)
		if (sets.length > 0) {
			db.prepare(`UPDATE mitglieder SET ${sets.join(', ')} WHERE id = @id`).run(
				params,
			)
		}
	} else {
		db.prepare<{
			id: string
			first_name: string
			last_name: string
			email: string | null
		}>(
			`INSERT INTO mitglieder (id, first_name, last_name, email)
       VALUES (@id, @first_name, @last_name, @email)`,
		).run({
			id,
			first_name: input.first_name,
			last_name: input.last_name,
			email: input.email ?? null,
		})
	}

	if (input.groups !== undefined) {
		syncGroups(id, input.groups, db)
	}
	const row = getMitglied(id, db)
	if (!row) {
		throw new Error(`upsertMitglied: Zeile ${id} nach INSERT verschwunden`)
	}
	return row
}

/**
 * Setzt die Group-Mitgliedschaften einer Person auf exakt `groupKeys`.
 * Validiert jeden Key gegen die Whitelist `groups` und wirft bei unbekanntem
 * Key, BEVOR irgendetwas geaendert wird. Bewusst OHNE eigene Transaktion,
 * damit der Aufruf innerhalb der `bulkUpsertMitglieder`-Transaktion nicht
 * verschachtelt (better-sqlite3 erlaubt keine geschachtelten Transaktionen).
 */
const syncGroups = (
	mitgliedId: string,
	groupKeys: string[],
	db: Database,
): void => {
	const unique = [...new Set(groupKeys)]
	const exists = db.prepare<[string], { key: string }>(
		'SELECT key FROM groups WHERE key = ?',
	)
	for (const key of unique) {
		if (!exists.get(key)) {
			throw new Error(
				`Unbekannte Gruppe "${key}". Erst via upsert_group anlegen (list_groups zeigt vorhandene Gruppen).`,
			)
		}
	}
	db.prepare<[string]>(
		'DELETE FROM group_memberships WHERE mitglied_id = ?',
	).run(mitgliedId)
	const ins = db.prepare<[string, string]>(
		'INSERT INTO group_memberships (group_key, mitglied_id) VALUES (?, ?)',
	)
	for (const key of unique) ins.run(key, mitgliedId)
}

export const bulkUpsertMitglieder = (
	inputs: MitgliedInput[],
	db: Database = openDb(),
): MitgliedRow[] => {
	const tx = db.transaction((items: MitgliedInput[]) =>
		items.map((item) => upsertMitglied(item, db)),
	)
	return tx(inputs)
}

export const deleteMitglied = (id: string, db: Database = openDb()): boolean =>
	db.prepare<[string]>('DELETE FROM mitglieder WHERE id = ?').run(id).changes >
	0

/** Wirft, wenn die Group nicht in der Whitelist `groups` existiert. */
const assertGroupExists = (groupKey: string, db: Database): void => {
	const group = db
		.prepare<[string], { key: string }>('SELECT key FROM groups WHERE key = ?')
		.get(groupKey)
	if (!group) {
		throw new Error(
			`Unbekannte Gruppe "${groupKey}". list_groups zeigt vorhandene Gruppen.`,
		)
	}
}

/** Wirft, wenn eine der IDs kein existierendes Mitglied ist. */
const assertMitgliederExist = (ids: string[], db: Database): void => {
	for (const id of ids) {
		if (!getMitglied(id, db)) {
			throw new Error(`Kein Eintrag im Adressbuch mit id="${id}".`)
		}
	}
}

/**
 * Fuegt eine einzelne Group-Mitgliedschaft hinzu (idempotent). Liefert die
 * danach gueltigen Group-Keys der Person.
 */
export const addToGroup = (
	groupKey: string,
	mitgliedId: string,
	db: Database = openDb(),
): string[] => {
	assertMitgliederExist([mitgliedId], db)
	assertGroupExists(groupKey, db)
	db.prepare<[string, string]>(
		'INSERT OR IGNORE INTO group_memberships (group_key, mitglied_id) VALUES (?, ?)',
	).run(groupKey, mitgliedId)
	return getMitgliedGroups(mitgliedId, db)
}

/** Entfernt eine einzelne Group-Mitgliedschaft. */
export const removeFromGroup = (
	groupKey: string,
	mitgliedId: string,
	db: Database = openDb(),
): string[] => {
	db.prepare<[string, string]>(
		'DELETE FROM group_memberships WHERE group_key = ? AND mitglied_id = ?',
	).run(groupKey, mitgliedId)
	return getMitgliedGroups(mitgliedId, db)
}

/** Resultat der Bulk-/Set-Operationen auf einer Group. */
export type GroupMembershipResult = {
	group: string
	/** IDs, die durch die Operation NEU hinzugekommen sind. */
	added: string[]
	/** IDs, die durch die Operation entfernt wurden. */
	removed: string[]
	/** Mitglieder-IDs der Group NACH der Operation. */
	members: string[]
}

/**
 * Fuegt mehrere Personen in einem Call zu einer Group hinzu (idempotent, in
 * einer Transaktion). Validiert Group und alle IDs vorab.
 */
export const bulkAddToGroup = (
	groupKey: string,
	mitgliedIds: string[],
	db: Database = openDb(),
): GroupMembershipResult => {
	assertGroupExists(groupKey, db)
	const unique = [...new Set(mitgliedIds)]
	assertMitgliederExist(unique, db)
	const before = new Set(listMitgliederByGroup(groupKey, db).map((r) => r.id))
	const tx = db.transaction((ids: string[]) => {
		const ins = db.prepare<[string, string]>(
			'INSERT OR IGNORE INTO group_memberships (group_key, mitglied_id) VALUES (?, ?)',
		)
		for (const id of ids) ins.run(groupKey, id)
	})
	tx(unique)
	return {
		group: groupKey,
		added: unique.filter((id) => !before.has(id)),
		removed: [],
		members: listMitgliederByGroup(groupKey, db).map((r) => r.id),
	}
}

/**
 * Entfernt mehrere Personen in einem Call aus einer Group. Unbekannte/nicht
 * zugeordnete IDs werden still ignoriert.
 */
export const bulkRemoveFromGroup = (
	groupKey: string,
	mitgliedIds: string[],
	db: Database = openDb(),
): GroupMembershipResult => {
	assertGroupExists(groupKey, db)
	const unique = [...new Set(mitgliedIds)]
	const before = new Set(listMitgliederByGroup(groupKey, db).map((r) => r.id))
	const tx = db.transaction((ids: string[]) => {
		const del = db.prepare<[string, string]>(
			'DELETE FROM group_memberships WHERE group_key = ? AND mitglied_id = ?',
		)
		for (const id of ids) del.run(groupKey, id)
	})
	tx(unique)
	return {
		group: groupKey,
		added: [],
		removed: unique.filter((id) => before.has(id)),
		members: listMitgliederByGroup(groupKey, db).map((r) => r.id),
	}
}

/**
 * Setzt die Mitgliederliste einer Group in einem Call auf exakt `mitgliedIds`
 * (Diff gegen Ist-Zustand). ACHTUNG: nicht aufgefuehrte bisherige Mitglieder
 * werden entfernt. Validiert Group und alle IDs vorab.
 */
export const setGroupMembers = (
	groupKey: string,
	mitgliedIds: string[],
	db: Database = openDb(),
): GroupMembershipResult => {
	assertGroupExists(groupKey, db)
	const desired = [...new Set(mitgliedIds)]
	assertMitgliederExist(desired, db)
	const before = new Set(listMitgliederByGroup(groupKey, db).map((r) => r.id))
	const desiredSet = new Set(desired)
	const tx = db.transaction((ids: string[]) => {
		db.prepare<[string]>(
			'DELETE FROM group_memberships WHERE group_key = ?',
		).run(groupKey)
		const ins = db.prepare<[string, string]>(
			'INSERT INTO group_memberships (group_key, mitglied_id) VALUES (?, ?)',
		)
		for (const id of ids) ins.run(groupKey, id)
	})
	tx(desired)
	return {
		group: groupKey,
		added: desired.filter((id) => !before.has(id)),
		removed: [...before].filter((id) => !desiredSet.has(id)),
		members: listMitgliederByGroup(groupKey, db).map((r) => r.id),
	}
}
