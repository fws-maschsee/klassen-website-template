import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getGroup } from '../../../lib/db/groups.js'
import {
	bulkUpsertMitglieder,
	deleteMitglied,
	getMitglied,
	getMitgliedGroups,
	listMitglieder,
	searchMitglieder,
	upsertMitglied,
} from '../../../lib/db/members.js'
import type { MitgliedRow } from '../../../lib/db/types.js'
import { syncMembersFromZitadel } from '../../auth/mirror.js'
import type { McpAuth } from '../guard.js'
import { registerPersonalDataTool, registerWriteTool } from '../guard.js'

/**
 * Das Adressbuch speichert bewusst nur Name und E-Mail — mehr braucht der
 * Versand nicht. Anrede, Telefonnummer und Notizen gab es einmal und sind
 * entfernt worden (Datenminimierung, Entscheidung des Betreibers).
 */
const MitgliedInputShape = {
	id: z
		.string()
		.optional()
		.describe(
			'Stabile ID. Wird aus dem Namen abgeleitet, wenn weggelassen. Bei Namensgleichheit explizit setzen.',
		),
	first_name: z.string().min(1),
	last_name: z.string().min(1),
	email: z.string().email().optional().nullable(),
	groups: z
		.array(z.string())
		.optional()
		.describe(
			"Group-Keys, in denen die Person ist (z.B. ['eltern']). Wird SYNCHRONISIERT: weglassen = unveraendert, [] = alle entfernen, [...] = exakt diese setzen. Keys muessen via list_groups existieren. Alternativ einzeln via add_to_group/remove_from_group.",
		),
}

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

/** Haengt die aktuellen Group-Keys an die Row-Ausgabe an. */
const withGroups = (row: MitgliedRow): MitgliedRow & { groups: string[] } => ({
	...row,
	groups: getMitgliedGroups(row.id),
})

export const registerMitgliederTools = (
	server: McpServer,
	auth: McpAuth,
): void => {
	registerPersonalDataTool(
		server,
		auth,
		'list_mitglieder',
		{
			title: 'Adressbuch auflisten',
			description:
				'Listet alle Eintraege des Adressbuchs (Eltern, Lehrkraefte, Ansprechpartner) alphabetisch nach Nachname, jeweils mit ihren Group-Keys.',
			inputSchema: {},
		},
		() => ({
			content: [
				{ type: 'text', text: toJson(listMitglieder().map(withGroups)) },
			],
		}),
	)

	registerPersonalDataTool(
		server,
		auth,
		'get_mitglied',
		{
			title: 'Einzelnen Eintrag abfragen',
			description: 'Liefert einen Adressbuch-Eintrag per ID.',
			inputSchema: { id: z.string() },
		},
		({ id }) => {
			const row = getMitglied(id)
			if (!row) {
				return {
					isError: true,
					content: [{ type: 'text', text: `Kein Eintrag mit id=${id}` }],
				}
			}
			return { content: [{ type: 'text', text: toJson(withGroups(row)) }] }
		},
	)

	registerPersonalDataTool(
		server,
		auth,
		'search_mitglieder',
		{
			title: 'Adressbuch durchsuchen',
			description:
				"Tolerante Suche statt blindem Raten von IDs. Freitext (query) matcht case- und diakritik-insensitiv als Teilstring ueber Vorname, Nachname und E-Mail ('Doss' findet 'Doß'). Optionale Filter: group (nur Personen in dieser Gruppe, EFFEKTIV inkl. Untergruppen), has_email. Ohne Treffer kommt eine leere Liste zurueck — dann nicht raten, sondern nachfragen.",
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe('Freitext ueber Name und E-Mail.'),
				group: z
					.string()
					.optional()
					.describe('Nur Personen in dieser Gruppe (Key, siehe list_groups).'),
				has_email: z
					.boolean()
					.optional()
					.describe('true = nur mit E-Mail, false = nur ohne.'),
			},
		},
		({ query, group, has_email }) => {
			if (group !== undefined && !getGroup(group)) {
				return {
					isError: true,
					content: [
						{
							type: 'text',
							text: `Unbekannte Gruppe "${group}". list_groups zeigt vorhandene Gruppen.`,
						},
					],
				}
			}
			const result = searchMitglieder({ query, group, has_email }).map(
				withGroups,
			)
			return {
				content: [
					{ type: 'text', text: toJson({ count: result.length, result }) },
				],
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'upsert_mitglied',
		{
			title: 'Adressbuch-Eintrag anlegen oder aktualisieren',
			description:
				'Legt eine Person an oder aktualisiert sie. Pflicht: first_name, last_name. Zugehoerigkeiten via groups[]. PARTIELLES UPDATE: Beim Aktualisieren werden nur die mitgeschickten Felder veraendert — ein Feld weglassen laesst es unveraendert, explizit null leert es (z.B. email: null entfernt die Adresse).',
			inputSchema: MitgliedInputShape,
		},
		// Felder werden 1:1 durchgereicht (kein `?? null`): so bleibt die
		// Unterscheidung "weggelassen" (undefined => unveraendert) vs. "explizit
		// null" (=> leeren) bis in upsertMitglied erhalten.
		(input) => {
			try {
				const row = upsertMitglied({
					id: input.id,
					first_name: input.first_name,
					last_name: input.last_name,
					email: input.email,
					groups: input.groups,
				})
				return { content: [{ type: 'text', text: toJson(withGroups(row)) }] }
			} catch (err) {
				return {
					isError: true,
					content: [{ type: 'text', text: (err as Error).message }],
				}
			}
		},
	)

	const MitgliedInputObject = z.object(MitgliedInputShape)

	registerWriteTool(
		server,
		auth,
		'bulk_upsert_mitglieder',
		{
			title: 'Mehrere Eintraege auf einmal anlegen/aktualisieren',
			description:
				'Batch-Variante von upsert_mitglied: legt die Personen in EINER Transaktion an bzw. aktualisiert sie. Schlaegt ein Eintrag fehl, wird nichts geschrieben. Ideal fuer den Erstimport einer Klassenliste.',
			inputSchema: { items: z.array(MitgliedInputObject).min(1) },
		},
		({ items }) => {
			try {
				const written = bulkUpsertMitglieder(
					items.map((input) => ({
						id: input.id,
						first_name: input.first_name,
						last_name: input.last_name,
						email: input.email,
						groups: input.groups,
					})),
				)
				return {
					content: [
						{
							type: 'text',
							text: toJson({
								count: written.length,
								ids: written.map((m) => m.id),
							}),
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
		'sync_mitglieder',
		{
			title: 'Empfaenger mit ZITADEL abgleichen',
			description:
				'Holt alle Personen mit dem Rollen-Grant dieser Klasse aus ZITADEL und schreibt sie ins Adressbuch. Die id wird wie ueberall aus dem Namen abgeleitet (vorname-nachname, bei Namensgleichheit mit -2/-3); die ZITADEL-Nutzernummer steht intern und wird nicht ausgegeben. Wer keinen Grant mehr hat, wird entfernt. Von Hand angelegte Eintraege bleiben unberuehrt — sie sind fuer Adressen ohne Zugang gedacht (Grosseltern, Lehrkraefte, externe Kontakte). Der Abgleich laeuft ausserdem automatisch vor jeder eingehenden Listenmail; dieses Werkzeug ist fuer den Blick zwischendurch.',
			inputSchema: {},
		},
		async () => {
			try {
				const result = await syncMembersFromZitadel()
				return { content: [{ type: 'text', text: toJson(result) }] }
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
		'delete_mitglied',
		{
			title: 'Adressbuch-Eintrag loeschen',
			description:
				'Loescht eine Person. Ihre Gruppen-Mitgliedschaften, Opt-outs und Send-Log-Eintraege verschwinden mit (FK CASCADE).',
			inputSchema: { id: z.string() },
		},
		({ id }) => {
			const deleted = deleteMitglied(id)
			return {
				content: [
					{
						type: 'text',
						text: deleted
							? `Eintrag ${id} geloescht.`
							: `Eintrag ${id} existierte nicht.`,
					},
				],
			}
		},
	)
}
