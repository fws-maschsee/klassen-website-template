import type { Database } from 'better-sqlite3'
import { openDb } from './index.js'
import type { MitgliedInput, MitgliedRow } from './types.js'

export const GROUP_ELTERN = 'eltern'

const COLUMNS = 'id, first_name, last_name, email, created_at, updated_at'

const cols = (alias: string): string =>
	COLUMNS.split(', ')
		.map((c) => `${alias}.${c}`)
		.join(', ')

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

export const uniqueMemberId = (
	firstName: string,
	lastName: string,
	db: Database = openDb(),
	keepId?: string,
): string => {
	const base = slugify(firstName, lastName)
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

const foldText = (value: string): string =>
	value.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '')

export type MitgliederSearchFilter = {
	query?: string
	group?: string
	has_email?: boolean
}

const isSet = (value: string | null): boolean =>
	value != null && value.trim() !== ''

export const searchMitglieder = (
	filter: MitgliederSearchFilter,
	db: Database = openDb(),
): MitgliedRow[] => {
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

const assertMitgliederExist = (ids: string[], db: Database): void => {
	for (const id of ids) {
		if (!getMitglied(id, db)) {
			throw new Error(`Kein Eintrag im Adressbuch mit id="${id}".`)
		}
	}
}

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

export type GroupMembershipResult = {
	group: string
	added: string[]
	removed: string[]
	members: string[]
}

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
