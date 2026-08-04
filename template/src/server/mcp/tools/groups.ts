import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	addSubgroup,
	deleteGroup,
	getGroup,
	listGroups,
	removeSubgroup,
	setSubgroups,
	upsertGroup,
} from '../../../lib/db/groups.js'
import {
	addToGroup,
	bulkAddToGroup,
	bulkRemoveFromGroup,
	listMitgliederByGroup,
	listMitgliederByGroupEffective,
	removeFromGroup,
	setGroupMembers,
} from '../../../lib/db/members.js'
import type { McpAuth } from '../guard.js'
import {
	registerPersonalDataTool,
	registerReadTool,
	registerWriteTool,
} from '../guard.js'

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

// Key-Konvention: Kleinbuchstaben, Ziffern und Bindestriche, z.B.
// "eltern" oder "elternvertretung". Verhindert Tippfehler-Keys.
const GroupKeySchema = z
	.string()
	.regex(
		/^[a-z0-9]+(-[a-z0-9]+)*$/,
		"Nur Kleinbuchstaben, Ziffern und Bindestriche, z.B. 'elternvertretung'.",
	)

export const registerGroupTools = (server: McpServer, auth: McpAuth): void => {
	registerReadTool(
		server,
		auth,
		'list_groups',
		{
			title: 'Gruppen auflisten',
			description:
				"Listet alle Gruppen (die Whitelist) inkl. Mitgliederzahlen und Hierarchie. Pro Gruppe: `mitglieder` (DIREKT zugeordnet), `mitglieder_effektiv` (direkt + alle Personen der rekursiven Untergruppen, dedupliziert), `children` (direkte Untergruppen) und `parents` (direkte Obergruppen). Die Gruppe 'eltern' wird beim Anlegen der Datenbank erzeugt, alle weiteren legt man hier selbst an. Diese Keys sind als `groups[]` beim upsert_mitglied bzw. in add_to_group/remove_from_group gueltig. Ober-/Untergruppen pflegt man mit add_subgroup/remove_subgroup/set_subgroups.",
			inputSchema: {},
		},
		() => ({ content: [{ type: 'text', text: toJson(listGroups()) }] }),
	)

	registerWriteTool(
		server,
		auth,
		'upsert_group',
		{
			title: 'Gruppe anlegen oder umbenennen',
			description:
				"Legt eine neue Gruppe an oder aktualisiert Label/aktiv-Flag. key ist stabil und technisch (z.B. 'elternvertretung'), label ist die Anzeige (z.B. 'Elternvertretung').",
			inputSchema: {
				key: GroupKeySchema,
				label: z.string().min(1),
				aktiv: z
					.boolean()
					.optional()
					.describe(
						'Default true. false blendet die Gruppe aus, ohne sie zu loeschen.',
					),
			},
		},
		({ key, label, aktiv }) => {
			const row = upsertGroup({ key, label, aktiv: aktiv ?? true })
			return { content: [{ type: 'text', text: toJson(row) }] }
		},
	)

	registerWriteTool(
		server,
		auth,
		'delete_group',
		{
			title: 'Gruppe loeschen',
			description:
				'Loescht eine Gruppe. Die zugeordneten Mitgliedschaften und die Hierarchie-Kanten werden mitgeloescht (FK CASCADE), die Personen selbst bleiben erhalten.',
			inputSchema: { key: GroupKeySchema },
		},
		({ key }) => {
			const deleted = deleteGroup(key)
			return {
				content: [
					{
						type: 'text',
						text: deleted
							? `Gruppe ${key} geloescht.`
							: `Gruppe ${key} existierte nicht.`,
					},
				],
			}
		},
	)

	registerPersonalDataTool(
		server,
		auth,
		'list_group_members',
		{
			title: 'Personen einer Gruppe',
			description:
				'Liefert alle Personen einer Gruppe. Standardmaessig EFFEKTIV, also inklusive der Personen aller (rekursiven) Untergruppen — eine Obergruppe zeigt damit auch alle Mitglieder ihrer Untergruppen. Mit `nur_direkt: true` kommen nur die DIREKT zugeordneten Personen (die, die hier per add_to_group eingetragen sind).',
			inputSchema: {
				key: GroupKeySchema,
				nur_direkt: z
					.boolean()
					.optional()
					.describe(
						'Default false. true = nur direkt zugeordnete Personen, ohne Untergruppen.',
					),
			},
		},
		({ key, nur_direkt }) => {
			if (!getGroup(key)) {
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: `Unbekannte Gruppe "${key}". list_groups zeigt vorhandene Gruppen.`,
						},
					],
				}
			}
			const members = nur_direkt
				? listMitgliederByGroup(key)
				: listMitgliederByGroupEffective(key)
			return {
				content: [{ type: 'text', text: toJson(members) }],
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'add_subgroup',
		{
			title: 'Untergruppe zuordnen',
			description:
				"Macht `child` zu einer Untergruppe von `parent` (idempotent). Danach zaehlen alle Personen der Untergruppe (rekursiv) effektiv zur Obergruppe — ohne dass jemand doppelt gepflegt werden muss. Beispiel: add_subgroup(parent='eltern', child='elternvertretung'). Beide Gruppen muessen existieren (siehe list_groups). Zyklen werden abgelehnt. Liefert die danach gueltigen direkten Untergruppen von `parent`.",
			inputSchema: {
				parent: GroupKeySchema.describe('Obergruppe (Superset).'),
				child: GroupKeySchema.describe('Untergruppe (Subset).'),
			},
		},
		({ parent, child }) => {
			try {
				const children = addSubgroup(parent, child)
				return {
					content: [{ type: 'text', text: toJson({ parent, children }) }],
				}
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text', text: (err as Error).message }],
				}
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'remove_subgroup',
		{
			title: 'Untergruppe entfernen',
			description:
				'Hebt die Ober-/Untergruppen-Beziehung `parent -> child` auf (die Gruppen selbst und ihre Mitglieder bleiben erhalten). Liefert die danach gueltigen direkten Untergruppen von `parent`.',
			inputSchema: {
				parent: GroupKeySchema,
				child: GroupKeySchema,
			},
		},
		({ parent, child }) => {
			const children = removeSubgroup(parent, child)
			return {
				content: [{ type: 'text', text: toJson({ parent, children }) }],
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'set_subgroups',
		{
			title: 'Untergruppen einer Obergruppe setzen',
			description:
				'Setzt die direkten Untergruppen von `parent` in EINEM Call auf exakt die uebergebene Liste (Diff gegen Ist-Zustand). ACHTUNG: nicht aufgefuehrte bisherige Untergruppen werden entfernt. Leeres Array = alle Untergruppen loesen. Validiert alle Keys und prueft auf Zyklen, BEVOR etwas geaendert wird. Liefert added/removed und die resultierenden Untergruppen.',
			inputSchema: {
				parent: GroupKeySchema,
				children: z
					.array(GroupKeySchema)
					.describe('Exakte Soll-Liste der direkten Untergruppen-Keys.'),
			},
		},
		({ parent, children }) => {
			try {
				return {
					content: [
						{ type: 'text', text: toJson(setSubgroups(parent, children)) },
					],
				}
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text', text: (err as Error).message }],
				}
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'add_to_group',
		{
			title: 'Person zu Gruppe hinzufuegen',
			description:
				'Fuegt eine Person zu einer Gruppe hinzu (idempotent). list_groups zeigt die verfuegbaren Gruppen. Liefert die danach gueltigen Group-Keys der Person.',
			inputSchema: {
				key: GroupKeySchema.describe('Group-Key, siehe list_groups.'),
				mitglied_id: z
					.string()
					.describe(
						'ID der Person (siehe list_mitglieder / search_mitglieder).',
					),
			},
		},
		({ key, mitglied_id }) => {
			try {
				const groups = addToGroup(key, mitglied_id)
				return {
					content: [{ type: 'text', text: toJson({ mitglied_id, groups }) }],
				}
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text', text: (err as Error).message }],
				}
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'remove_from_group',
		{
			title: 'Person aus Gruppe entfernen',
			description:
				'Entfernt eine Person aus einer Gruppe. Liefert die danach gueltigen Group-Keys der Person.',
			inputSchema: {
				key: GroupKeySchema,
				mitglied_id: z.string(),
			},
		},
		({ key, mitglied_id }) => {
			const groups = removeFromGroup(key, mitglied_id)
			return {
				content: [{ type: 'text', text: toJson({ mitglied_id, groups }) }],
			}
		},
	)

	const MitgliedIdsSchema = z
		.array(z.string().min(1))
		.min(1)
		.describe(
			'IDs aus dem Adressbuch (siehe list_mitglieder / search_mitglieder).',
		)

	registerWriteTool(
		server,
		auth,
		'bulk_add_to_group',
		{
			title: 'Mehrere Personen zu Gruppe hinzufuegen',
			description:
				'Fuegt mehrere Personen in einem Call zu einer Gruppe hinzu (idempotent). Validiert Gruppe und alle IDs vorab — schlaegt eine ID fehl, wird nichts geaendert. Liefert die neu hinzugekommenen (added) und alle resultierenden Mitglieder (members).',
			inputSchema: { key: GroupKeySchema, mitglied_ids: MitgliedIdsSchema },
		},
		({ key, mitglied_ids }) => {
			try {
				return {
					content: [
						{ type: 'text', text: toJson(bulkAddToGroup(key, mitglied_ids)) },
					],
				}
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text', text: (err as Error).message }],
				}
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'bulk_remove_from_group',
		{
			title: 'Mehrere Personen aus Gruppe entfernen',
			description:
				'Entfernt mehrere Personen in einem Call aus einer Gruppe. Nicht zugeordnete IDs werden ignoriert. Liefert die tatsaechlich entfernten (removed) und die resultierenden Mitglieder (members).',
			inputSchema: { key: GroupKeySchema, mitglied_ids: MitgliedIdsSchema },
		},
		({ key, mitglied_ids }) => {
			try {
				return {
					content: [
						{
							type: 'text',
							text: toJson(bulkRemoveFromGroup(key, mitglied_ids)),
						},
					],
				}
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text', text: (err as Error).message }],
				}
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'set_group_members',
		{
			title: 'Mitgliederliste einer Gruppe setzen',
			description:
				'Setzt die Mitgliederliste einer Gruppe in EINEM Call auf exakt die uebergebenen IDs (Diff gegen Ist-Zustand). Ideal zum Konsolidieren einer Verteilerliste. ACHTUNG: nicht aufgefuehrte bisherige Mitglieder werden entfernt. Leeres Array = Gruppe leeren. Validiert Gruppe und alle IDs vorab. Liefert added/removed und die resultierenden Mitglieder.',
			inputSchema: {
				key: GroupKeySchema,
				mitglied_ids: z
					.array(z.string().min(1))
					.describe(
						'Exakte Soll-Mitgliederliste (IDs). [] leert die Gruppe vollstaendig.',
					),
			},
		},
		({ key, mitglied_ids }) => {
			try {
				return {
					content: [
						{ type: 'text', text: toJson(setGroupMembers(key, mitglied_ids)) },
					],
				}
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text', text: (err as Error).message }],
				}
			}
		},
	)
}
