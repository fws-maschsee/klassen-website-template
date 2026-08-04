import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { listGroups } from '../../../lib/db/groups.js'
import { dbPath } from '../../../lib/db/index.js'
import {
	checkInstance,
	instanceLabel,
	instanceName,
} from '../../../lib/db/instance.js'
import { listMailingLists } from '../../../lib/db/mailingLists.js'
import { listMitglieder } from '../../../lib/db/members.js'
import { listDomain, mailFrom } from '../../../lib/email/config.js'
import { authProvider } from '../../auth/index.js'
import { canEdit, canSeePersonalData } from '../../auth/roles.js'
import { type McpAuth, registerReadTool, rolesFor } from '../guard.js'

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

/**
 * `get_instance_info` (whoami). Es gibt ein Deployment PRO KLASSE mit eigener
 * SQLite-Datei. Im MCP-Client sehen die Instanzen sich sehr aehnlich, und wer
 * in der falschen Instanz schreibt, verschickt Elternpost an die falsche
 * Klasse. Dieses Tool beantwortet vor jedem Schreibzugriff die Frage: mit WEM
 * arbeite ich hier gerade?
 */
export const registerInstanceTools = (
	server: McpServer,
	auth: McpAuth,
): void => {
	registerReadTool(
		server,
		auth,
		'get_instance_info',
		{
			title: 'Instanz-Info (whoami)',
			description:
				'Vergewisserung, mit WELCHER Klasse/Datenbank gerade gearbeitet wird, BEVOR geschrieben oder verschickt wird. Liefert Instanz-Label, Servername, DB-Datei, den in der Datei hinterlegten Instanznamen (muss zur Konfiguration passen), Absenderadresse, Listen-Domain, die eigenen Rollen (`may_see_personal_data` sagt, ob Namen und Adressen sichtbar sind, `may_edit`, ob dieser Zugang aendern darf) sowie Eckdaten (Anzahl Eintraege/Gruppen/Listen).',
			inputSchema: {},
		},
		async () => {
			const check = checkInstance()
			// Die eigenen Rechte kommen aus derselben Quelle wie jede andere
			// Pruefung: frisch aus ZITADEL, nicht aus dem Token.
			const roles = await rolesFor(auth)
			return {
				content: [
					{
						type: 'text',
						text: toJson({
							instance_label: instanceLabel(),
							instance_name: instanceName(),
							db_file: path.basename(dbPath()),
							db_recorded_instance: check.recorded,
							instance_matches: check.ok,
							mail_from: mailFrom(),
							list_domain: listDomain(),
							auth_provider: authProvider().name,
							// Wer bin ich hier, und darf ich schreiben? Erspart dem
							// Client den Versuch, an dem er sonst nur die Fehlermeldung
							// liest.
							user_id: auth.userId,
							roles,
							// Was dieser Zugang darf, in der Sprache der Werkzeuge:
							// Verteiler sehen kann jeder Angemeldete, Namen und
							// Adressen nur `admin`, aendern ebenfalls nur `admin`.
							may_see_personal_data: canSeePersonalData(roles),
							may_edit: canEdit(roles),
							mitglieder_count: listMitglieder().length,
							groups_count: listGroups().length,
							mailing_lists_count: listMailingLists().length,
						}),
					},
				],
			}
		},
	)
}
