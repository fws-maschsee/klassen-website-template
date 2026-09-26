import type { Database } from 'better-sqlite3'
import { openDb } from './index.js'
import type { GroupInput, GroupRow } from './types.js'

export type GroupMitCount = GroupRow & {
	mitglieder: number
	mitglieder_effektiv: number
	children: string[]
	parents: string[]
}

export const listGroups = (db: Database = openDb()): GroupMitCount[] => {
	const base = db
		.prepare<[], GroupRow & { mitglieder: number }>(
			`SELECT g.*, COUNT(gm.mitglied_id) AS mitglieder
         FROM groups g
         LEFT JOIN group_memberships gm ON gm.group_key = g.key
        GROUP BY g.key
        ORDER BY g.key`,
		)
		.all()
	return base.map((g) => ({
		...g,
		mitglieder_effektiv: effectiveMemberCount(g.key, db),
		children: listChildGroups(g.key, db),
		parents: listParentGroups(g.key, db),
	}))
}

export const getGroup = (
	key: string,
	db: Database = openDb(),
): GroupRow | undefined =>
	db.prepare<[string], GroupRow>('SELECT * FROM groups WHERE key = ?').get(key)

export const upsertGroup = (
	input: GroupInput,
	db: Database = openDb(),
): GroupRow => {
	db.prepare<{ key: string; label: string; aktiv: 0 | 1 }>(
		`INSERT INTO groups (key, label, aktiv)
       VALUES (@key, @label, @aktiv)
     ON CONFLICT(key) DO UPDATE SET
       label = excluded.label,
       aktiv = excluded.aktiv`,
	).run({
		key: input.key,
		label: input.label,
		aktiv: input.aktiv === false ? 0 : 1,
	})
	const row = getGroup(input.key, db)
	if (!row) {
		throw new Error(`upsertGroup: Zeile ${input.key} nach INSERT verschwunden`)
	}
	return row
}

export const deleteGroup = (key: string, db: Database = openDb()): boolean =>
	db.prepare<[string]>('DELETE FROM groups WHERE key = ?').run(key).changes > 0

const assertGroupExists = (key: string, db: Database): void => {
	if (!getGroup(key, db)) {
		throw new Error(
			`Unbekannte Gruppe "${key}". list_groups zeigt vorhandene Gruppen.`,
		)
	}
}

export const listChildGroups = (
	parentKey: string,
	db: Database = openDb(),
): string[] =>
	db
		.prepare<[string], { child_key: string }>(
			'SELECT child_key FROM group_edges WHERE parent_key = ? ORDER BY child_key',
		)
		.all(parentKey)
		.map((r) => r.child_key)

export const listParentGroups = (
	childKey: string,
	db: Database = openDb(),
): string[] =>
	db
		.prepare<[string], { parent_key: string }>(
			'SELECT parent_key FROM group_edges WHERE child_key = ? ORDER BY parent_key',
		)
		.all(childKey)
		.map((r) => r.parent_key)

export const subtreeGroupKeys = (
	key: string,
	db: Database = openDb(),
): string[] =>
	db
		.prepare<[string], { key: string }>(
			// UNION statt UNION ALL: terminiert auch bei einem Zyklus in Altdaten.
			`WITH RECURSIVE subtree(key) AS (
         SELECT ?
         UNION
         SELECT e.child_key FROM group_edges e
           JOIN subtree s ON e.parent_key = s.key
       )
       SELECT key FROM subtree`,
		)
		.all(key)
		.map((r) => r.key)

export const ancestorGroupKeys = (
	key: string,
	db: Database = openDb(),
): string[] =>
	db
		.prepare<[string], { key: string }>(
			`WITH RECURSIVE ancestors(key) AS (
         SELECT parent_key FROM group_edges WHERE child_key = ?
         UNION
         SELECT e.parent_key FROM group_edges e
           JOIN ancestors a ON e.child_key = a.key
       )
       SELECT key FROM ancestors`,
		)
		.all(key)
		.map((r) => r.key)

export const expandToSubtrees = (
	keys: string[],
	db: Database = openDb(),
): string[] => {
	const out = new Set<string>()
	for (const key of keys) {
		for (const k of subtreeGroupKeys(key, db)) out.add(k)
	}
	return [...out]
}

export const effectiveMemberCount = (
	key: string,
	db: Database = openDb(),
): number =>
	db
		.prepare<[string], { n: number }>(
			`WITH RECURSIVE subtree(key) AS (
         SELECT ?
         UNION
         SELECT e.child_key FROM group_edges e
           JOIN subtree s ON e.parent_key = s.key
       )
       SELECT COUNT(DISTINCT gm.mitglied_id) AS n
         FROM group_memberships gm
        WHERE gm.group_key IN (SELECT key FROM subtree)`,
		)
		.get(key)?.n ?? 0

export const wouldCreateCycle = (
	parentKey: string,
	childKey: string,
	db: Database = openDb(),
): boolean =>
	parentKey === childKey || subtreeGroupKeys(childKey, db).includes(parentKey)

export const addSubgroup = (
	parentKey: string,
	childKey: string,
	db: Database = openDb(),
): string[] => {
	assertGroupExists(parentKey, db)
	assertGroupExists(childKey, db)
	if (parentKey === childKey) {
		throw new Error('Eine Gruppe kann nicht ihre eigene Untergruppe sein.')
	}
	if (wouldCreateCycle(parentKey, childKey, db)) {
		throw new Error(
			`Zyklus verhindert: "${parentKey}" haengt bereits (direkt oder indirekt) unter "${childKey}".`,
		)
	}
	db.prepare<[string, string]>(
		'INSERT OR IGNORE INTO group_edges (parent_key, child_key) VALUES (?, ?)',
	).run(parentKey, childKey)
	return listChildGroups(parentKey, db)
}

export const removeSubgroup = (
	parentKey: string,
	childKey: string,
	db: Database = openDb(),
): string[] => {
	db.prepare<[string, string]>(
		'DELETE FROM group_edges WHERE parent_key = ? AND child_key = ?',
	).run(parentKey, childKey)
	return listChildGroups(parentKey, db)
}

export type SubgroupResult = {
	parent: string
	added: string[]
	removed: string[]
	children: string[]
}

export const setSubgroups = (
	parentKey: string,
	childKeys: string[],
	db: Database = openDb(),
): SubgroupResult => {
	assertGroupExists(parentKey, db)
	const desired = [...new Set(childKeys)]
	for (const child of desired) {
		assertGroupExists(child, db)
		if (parentKey === child) {
			throw new Error('Eine Gruppe kann nicht ihre eigene Untergruppe sein.')
		}
		if (wouldCreateCycle(parentKey, child, db)) {
			throw new Error(
				`Zyklus verhindert: "${parentKey}" haengt bereits (direkt oder indirekt) unter "${child}".`,
			)
		}
	}
	const before = new Set(listChildGroups(parentKey, db))
	const desiredSet = new Set(desired)
	const tx = db.transaction(() => {
		db.prepare<[string]>('DELETE FROM group_edges WHERE parent_key = ?').run(
			parentKey,
		)
		const ins = db.prepare<[string, string]>(
			'INSERT INTO group_edges (parent_key, child_key) VALUES (?, ?)',
		)
		for (const child of desired) ins.run(parentKey, child)
	})
	tx()
	return {
		parent: parentKey,
		added: desired.filter((k) => !before.has(k)),
		removed: [...before].filter((k) => !desiredSet.has(k)),
		children: listChildGroups(parentKey, db),
	}
}
