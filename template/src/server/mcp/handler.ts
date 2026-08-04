import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { publicBaseUrl } from '../config.js'
import { mcpOAuthProvider } from '../oauth/provider.js'
import { authFromInfo } from './guard.js'
import { buildMcpServer } from './server.js'

/**
 * Bearer-Auth fuer `/mcp`: prueft den Authorization-Header gegen unseren
 * OAuth-Provider (Tokens in der lokalen SQLite) und antwortet bei Fehlern mit
 * 401 plus korrektem `WWW-Authenticate`-Header, damit der Client den
 * Discovery-/Login-Flow starten kann.
 *
 * Als Nebenwirkung haengt die Middleware das gepruefte Token als `req.auth`
 * an — daraus entstehen unten die Rollen des Aufrufers.
 */
export const mcpAuthMiddleware = requireBearerAuth({
	verifier: mcpOAuthProvider,
	resourceMetadataUrl: `${publicBaseUrl()}/.well-known/oauth-protected-resource`,
})

export const mcpRequestHandler = async (
	req: Request,
	res: Response,
): Promise<void> => {
	// Stateless: jeder Request bekommt einen frischen Transport + Server. Der
	// Server wird mit den Rollen GENAU DIESES Tokens gebaut; die
	// Schreib-Pruefung sitzt damit an derselben Stelle wie in der
	// Weboberflaeche (src/lib/roles.ts) und nicht in einem zweiten Regelwerk.
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
