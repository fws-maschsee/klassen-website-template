import type { Database } from 'better-sqlite3'
import { openDb } from './index.js'
import type { GroupInput, GroupRow } from './types.js'

/**
 * Eine Gruppe inkl. Mitgliederzahlen und Hierarchie:
 * - `mitglieder`: DIREKT zugeordnete Personen (Zeilen in group_memberships).
 * - `mitglieder_effektiv`: EFFEKTIV erreichte Personen = direkt + alle
 *   Personen der (rekursiven) Kindgruppen, dedupliziert. Ohne Kindgruppen
 *   identisch zu `mitglieder`.
 * - `children`: direkte Kindgruppen-Keys (diese Gruppe ist deren Obergruppe).
 * - `parents`: direkte Obergruppen-Keys (diese Gruppe ist deren Kind).
 */
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

/** Legt eine Gruppe an oder aktualisiert ihr Label/aktiv-Flag. */
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

/**
 * Loescht eine Gruppe. Mitgliedschaften UND Hierarchie-Kanten (als Parent wie
 * als Kind) verschwinden via FK CASCADE; die Personen selbst und die anderen
 * Gruppen bleiben erhalten.
 */
export const deleteGroup = (key: string, db: Database = openDb()): boolean =>
	db.prepare<[string]>('DELETE FROM groups WHERE key = ?').run(key).changes > 0

// ---------------------------------------------------------------------------
// Hierarchie: Ober-/Untergruppen (group_edges)
// ---------------------------------------------------------------------------

/** Wirft, wenn ein Group-Key nicht in der Whitelist `groups` existiert. */
const assertGroupExists = (key: string, db: Database): void => {
	if (!getGroup(key, db)) {
		throw new Error(
			`Unbekannte Gruppe "${key}". list_groups zeigt vorhandene Gruppen.`,
		)
	}
}

/** Direkte Kindgruppen-Keys einer Gruppe (alphabetisch). */
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

/** Direkte Obergruppen-Keys einer Gruppe (alphabetisch). */
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

/**
 * Der gesamte Teilbaum unter `key` INKLUSIVE `key` selbst: die Gruppe plus
 * alle ihre (rekursiven) Kindgruppen-Keys. Basis fuer die effektive
 * Mitgliedschaft. `UNION` (nicht `UNION ALL`) dedupliziert die Keys und
 * terminiert auch bei einem versehentlichen Zyklus in Altdaten.
 */
export const subtreeGroupKeys = (
	key: string,
	db: Database = openDb(),
): string[] =>
	db
		.prepare<[string], { key: string }>(
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

/**
 * Alle (rekursiven) Vorfahren von `key`, also alle Obergruppen, die `key`
 * effektiv enthalten — OHNE `key` selbst.
 */
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

/**
 * Erweitert eine Menge von Group-Keys um ihre kompletten Teilbaeume (alle
 * Nachfahren), dedupliziert. Wird beim Aufloesen von Verteilern genutzt, die
 * mehrere Gruppen referenzieren (z.B. Mailinglisten-Empfaengergruppen).
 */
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

/** Anzahl EFFEKTIV erreichter Personen (direkt + Kindgruppen, dedupliziert). */
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

/**
 * Wuerde die Kante `parent -> child` einen Zyklus erzeugen? Das ist der Fall,
 * wenn `parent` bereits (rekursiv) UNTER `child` haengt — dann schloesse die
 * neue Kante einen Kreis. Die triviale Selbst-Kante (parent === child) wird
 * ueber den CHECK in der Tabelle ohnehin verhindert, hier aber mit abgedeckt.
 */
export const wouldCreateCycle = (
	parentKey: string,
	childKey: string,
	db: Database = openDb(),
): boolean =>
	parentKey === childKey || subtreeGroupKeys(childKey, db).includes(parentKey)

/**
 * Macht `child` zu einer Untergruppe von `parent` (idempotent). Validiert,
 * dass beide Gruppen existieren, und verhindert Zyklen. Liefert die danach
 * gueltigen direkten Kindgruppen von `parent`.
 */
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

/**
 * Entfernt die Untergruppen-Beziehung `parent -> child`. Liefert die danach
 * gueltigen direkten Kindgruppen von `parent`.
 */
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

/** Resultat von `setSubgroups`. */
export type SubgroupResult = {
	parent: string
	/** Kind-Keys, die NEU hinzugekommen sind. */
	added: string[]
	/** Kind-Keys, die entfernt wurden. */
	removed: string[]
	/** Direkte Kindgruppen NACH der Operation (alphabetisch). */
	children: string[]
}

/**
 * Setzt die direkten Kindgruppen von `parent` in EINEM Call auf exakt
 * `childKeys` (Diff gegen Ist-Zustand). Validiert `parent`, alle Kinder und
 * prueft jeden neuen Kandidaten auf Zyklen, BEVOR etwas geschrieben wird — die
 * ganze Operation laeuft in einer Transaktion. `[]` loest alle Kinder.
 */
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
