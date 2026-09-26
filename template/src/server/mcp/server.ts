import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { instanceLabel, instanceName } from '../../lib/db/instance.js'
import type { McpAuth } from './guard.js'
import { registerEmailTools } from './tools/emails.js'
import { registerGroupTools } from './tools/groups.js'
import { registerInstanceTools } from './tools/instance.js'
import { registerMailingListTools } from './tools/mailingLists.js'
import { registerMitgliederTools } from './tools/members.js'

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
