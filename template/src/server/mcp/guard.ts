import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
	McpServer,
	RegisteredTool,
	ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
	AnySchema,
	ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { rolesForUser } from '../auth/grants.js'
import {
	type Capability,
	deniedMessage,
	may,
	ROLE_ADMIN,
} from '../auth/roles.js'

export type McpAuth = {
	userId: string
	roles?: string[]
}

export const authFromInfo = (info: AuthInfo | undefined): McpAuth => {
	const extra = (info?.extra ?? {}) as { userId?: unknown }
	return { userId: typeof extra.userId === 'string' ? extra.userId : '' }
}

export const rolesFor = async (auth: McpAuth): Promise<string[]> =>
	auth.roles ?? rolesForUser(auth.userId)

type GuardedToolConfig<
	InputArgs extends undefined | ZodRawShapeCompat | AnySchema,
	OutputArgs extends ZodRawShapeCompat | AnySchema,
> = {
	title?: string
	description?: string
	inputSchema?: InputArgs
	outputSchema?: OutputArgs
	annotations?: ToolAnnotations
	_meta?: Record<string, unknown>
}

const HINT: Record<Capability, string> = {
	lesen: '',
	personen: `\n\nLiefert personenbezogene Daten und erfordert deshalb die Rolle "${ROLE_ADMIN}" im ZITADEL-Projekt dieser Klasse.`,
	bearbeiten: `\n\nAendert Daten und erfordert deshalb die Rolle "${ROLE_ADMIN}" im ZITADEL-Projekt dieser Klasse.`,
}

export const registerGuardedTool = <
	OutputArgs extends ZodRawShapeCompat | AnySchema = ZodRawShapeCompat,
	InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
	server: McpServer,
	auth: McpAuth,
	capability: Capability,
	name: string,
	config: GuardedToolConfig<InputArgs, OutputArgs>,
	cb: ToolCallback<InputArgs>,
): RegisteredTool =>
	server.registerTool<OutputArgs, InputArgs>(
		name,
		{
			...config,
			description: `${config.description ?? ''}${HINT[capability]}`,
		},
		(async (...args: unknown[]) => {
			let roles: string[]
			try {
				roles = await rolesFor(auth)
			} catch (error) {
				return {
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: `Berechtigung konnte nicht geprueft werden: ${(error as Error).message}`,
						},
					],
				}
			}
			if (!may(roles, capability)) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: deniedMessage(capability) }],
				}
			}
			return (cb as (...passed: unknown[]) => unknown)(...args)
		}) as ToolCallback<InputArgs>,
	)

export const registerReadTool = <
	OutputArgs extends ZodRawShapeCompat | AnySchema = ZodRawShapeCompat,
	InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
	server: McpServer,
	auth: McpAuth,
	name: string,
	config: GuardedToolConfig<InputArgs, OutputArgs>,
	cb: ToolCallback<InputArgs>,
): RegisteredTool =>
	registerGuardedTool(server, auth, 'lesen', name, config, cb)

export const registerWriteTool = <
	OutputArgs extends ZodRawShapeCompat | AnySchema = ZodRawShapeCompat,
	InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
	server: McpServer,
	auth: McpAuth,
	name: string,
	config: GuardedToolConfig<InputArgs, OutputArgs>,
	cb: ToolCallback<InputArgs>,
): RegisteredTool =>
	registerGuardedTool(server, auth, 'bearbeiten', name, config, cb)

export const registerPersonalDataTool = <
	OutputArgs extends ZodRawShapeCompat | AnySchema = ZodRawShapeCompat,
	InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
	server: McpServer,
	auth: McpAuth,
	name: string,
	config: GuardedToolConfig<InputArgs, OutputArgs>,
	cb: ToolCallback<InputArgs>,
): RegisteredTool =>
	registerGuardedTool(server, auth, 'personen', name, config, cb)
