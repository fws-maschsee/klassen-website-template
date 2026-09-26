import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { publicBaseUrl } from '../config.js'
import { mcpOAuthProvider } from '../oauth/provider.js'
import { authFromInfo } from './guard.js'
import { buildMcpServer } from './server.js'

export const mcpAuthMiddleware = requireBearerAuth({
	verifier: mcpOAuthProvider,
	resourceMetadataUrl: `${publicBaseUrl()}/.well-known/oauth-protected-resource`,
})

export const mcpRequestHandler = async (
	req: Request,
	res: Response,
): Promise<void> => {
	const server = buildMcpServer(authFromInfo(req.auth))
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
	})

	res.on('close', () => {
		transport.close().catch(() => {})
		server.close().catch(() => {})
	})

	await server.connect(transport)
	await transport.handleRequest(req, res, req.body)
}
