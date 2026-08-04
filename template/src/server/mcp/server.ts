import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { instanceLabel, instanceName } from '../../lib/db/instance.js'
import type { McpAuth } from './guard.js'
import { registerEmailTools } from './tools/emails.js'
import { registerGroupTools } from './tools/groups.js'
import { registerInstanceTools } from './tools/instance.js'
import { registerMailingListTools } from './tools/mailingLists.js'
import { registerMitgliederTools } from './tools/members.js'

/**
 * Baut den MCP-Server. Name und Titel kommen aus `MCP_INSTANCE_NAME` bzw.
 * `MCP_INSTANCE_LABEL` — nur so sind die Klassen-Instanzen im Client
 * ueberhaupt auseinanderzuhalten. Wer sich nicht sicher ist, ruft
 * `get_instance_info` auf.
 *
 * `auth` traegt die Rollen des Aufrufers durch bis zu den Tools. Der Server
 * wird pro Request neu gebaut (siehe `handler.ts`), deshalb gehoert er genau
 * einem Bearer-Token — es gibt keinen Zustand, den ein zweiter Aufrufer erben
 * koennte.
 */
export const buildMcpServer = (auth: McpAuth): McpServer => {
	const server = new McpServer({
		name: instanceName(),
		version: '0.1.0',
		title: instanceLabel(),
	})

	registerInstanceTools(server, auth)
	registerMitgliederTools(server, auth)
	registerGroupTools(server, auth)
	registerEmailTools(server, auth)
	registerMailingListTools(server, auth)

	return server
}
