import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
	AuthorizationParams,
	OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
	OAuthClientInformationFull,
	OAuthTokenRevocationRequest,
	OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Response } from 'express'
import {
	type AccessToken,
	consumeAuthCode,
	createPendingAuthorization,
	getClient,
	issueTokens,
	registerClient,
	revokeToken,
	rotateRefreshToken,
	verifyAccessToken,
} from '../../lib/db/oauth.js'

const toClientInfo = (
	c: ReturnType<typeof getClient> extends infer R ? NonNullable<R> : never,
): OAuthClientInformationFull => ({
	client_id: c.client_id,
	client_secret: c.client_secret ?? undefined,
	client_name: c.client_name,
	redirect_uris: c.redirect_uris as [string, ...string[]],
	grant_types: c.grant_types,
	response_types: c.response_types,
	token_endpoint_auth_method: c.token_endpoint_auth_method,
	scope: c.scope ?? undefined,
	client_uri: c.client_uri ?? undefined,
	software_id: c.software_id ?? undefined,
	software_version: c.software_version ?? undefined,
	client_id_issued_at: c.client_id_issued_at,
	client_secret_expires_at: c.client_secret_expires_at,
})

const clientsStore: OAuthRegisteredClientsStore = {
	getClient(clientId) {
		const c = getClient(clientId)
		if (!c) return undefined
		return toClientInfo(c)
	},

	registerClient(client) {
		const redirectUris = client.redirect_uris ?? []
		if (redirectUris.length === 0) {
			throw new Error('redirect_uris required')
		}
		const { client: created, client_secret_plain } = registerClient({
			client_name:
				(client.client_name as string | undefined) ?? 'Unnamed MCP Client',
			redirect_uris: redirectUris,
			grant_types: client.grant_types,
			response_types: client.response_types,
			token_endpoint_auth_method: client.token_endpoint_auth_method,
			scope: client.scope,
			client_uri: client.client_uri,
			software_id: client.software_id,
			software_version: client.software_version,
		})
		return {
			...toClientInfo(created),
			...(client_secret_plain ? { client_secret: client_secret_plain } : {}),
		}
	},
}

const accessTokenToAuthInfo = (token: AccessToken, raw: string): AuthInfo => ({
	token: raw,
	clientId: token.client_id,
	scopes: token.scopes ?? [],
	expiresAt: token.expires_at,
	extra: { userId: token.user_id },
})

export const mcpOAuthProvider: OAuthServerProvider = {
	clientsStore,

	async authorize(
		client: OAuthClientInformationFull,
		params: AuthorizationParams,
		res: Response,
	): Promise<void> {
		const pendingId = createPendingAuthorization({
			client_id: client.client_id,
			redirect_uri: params.redirectUri,
			scopes: params.scopes,
			state: params.state,
			code_challenge: params.codeChallenge,
			resource: params.resource?.toString(),
		})
		res.redirect(`/oauth/consent?pending_id=${encodeURIComponent(pendingId)}`)
	},

	async challengeForAuthorizationCode(
		_client: OAuthClientInformationFull,
		authorizationCode: string,
	): Promise<string> {
		const { peekAuthCode } = await import('../../lib/db/oauth.js')
		const row = peekAuthCode(authorizationCode)
		if (!row) throw new Error('invalid_grant: code not found')
		return row.code_challenge
	},

	async exchangeAuthorizationCode(
		client: OAuthClientInformationFull,
		authorizationCode: string,
		_codeVerifier?: string,
		_redirectUri?: string,
		_resource?: URL,
	): Promise<OAuthTokens> {
		const consumed = consumeAuthCode(authorizationCode)
		if (consumed.client_id !== client.client_id) {
			throw new Error('invalid_grant: client mismatch')
		}
		const tokens = issueTokens({
			client_id: client.client_id,
			user_id: consumed.user_id,
			roles: consumed.roles,
			scopes: consumed.scopes,
			resource: consumed.resource,
		})
		return {
			access_token: tokens.access_token,
			token_type: 'Bearer',
			expires_in: tokens.expires_in,
			refresh_token: tokens.refresh_token,
			scope: consumed.scopes?.join(' '),
		}
	},

	async exchangeRefreshToken(
		client: OAuthClientInformationFull,
		refreshToken: string,
		_scopes?: string[],
		_resource?: URL,
	): Promise<OAuthTokens> {
		const newTokens = rotateRefreshToken(refreshToken)
		const access = verifyAccessToken(newTokens.access_token)
		if (!access || access.client_id !== client.client_id) {
			throw new Error('invalid_grant')
		}
		return {
			access_token: newTokens.access_token,
			token_type: 'Bearer',
			expires_in: newTokens.expires_in,
			refresh_token: newTokens.refresh_token,
			scope: access.scopes?.join(' '),
		}
	},

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const access = verifyAccessToken(token)
		if (!access) {
			throw new InvalidTokenError('Token unbekannt, abgelaufen oder widerrufen')
		}
		return accessTokenToAuthInfo(access, token)
	},

	async revokeToken(
		_client: OAuthClientInformationFull,
		request: OAuthTokenRevocationRequest,
	): Promise<void> {
		revokeToken(request.token)
	},
}
