import { createHash, randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { openDb } from './index.js'

export type OAuthClient = {
	client_id: string
	client_secret: string | null
	client_name: string
	redirect_uris: string[]
	grant_types: string[]
	response_types: string[]
	token_endpoint_auth_method: string
	scope: string | null
	client_uri: string | null
	software_id: string | null
	software_version: string | null
	client_id_issued_at: number
	client_secret_expires_at: number
	created_at: string
}

export type AuthCode = {
	code: string
	client_id: string
	user_id: string
	/** Projektrollen der Person zum Zeitpunkt der Zustimmung. */
	roles: string[] | null
	code_challenge: string
	code_challenge_method: string
	redirect_uri: string
	scopes: string[] | null
	resource: string | null
	expires_at: number
	used: 0 | 1
}

export type AccessToken = {
	token_hash: string
	client_id: string
	user_id: string
	/**
	 * PROTOKOLL, keine Autorisierungsquelle: welche Rollen bei der Zustimmung
	 * galten. Massgeblich ist ausschliesslich die Abfrage bei ZITADEL zur
	 * Laufzeit (`src/server/auth/grants.ts`).
	 */
	roles: string[] | null
	scopes: string[] | null
	resource: string | null
	expires_at: number
	revoked: 0 | 1
}

export type RefreshToken = {
	token_hash: string
	access_token_hash: string | null
	client_id: string
	user_id: string
	roles: string[] | null
	scopes: string[] | null
	resource: string | null
	expires_at: number
	revoked: 0 | 1
	replaced_by_hash: string | null
}

const sha256Hex = (s: string): string =>
	createHash('sha256').update(s).digest('hex')

const randomToken = (bytes = 32): string =>
	randomBytes(bytes).toString('base64url')

const parseJsonArray = (s: string | null): string[] | null => {
	if (!s) return null
	return JSON.parse(s) as string[]
}

// ───────────── Clients ─────────────

type ClientRow = {
	client_id: string
	client_secret: string | null
	client_name: string
	redirect_uris: string
	grant_types: string
	response_types: string
	token_endpoint_auth_method: string
	scope: string | null
	client_uri: string | null
	software_id: string | null
	software_version: string | null
	client_id_issued_at: number
	client_secret_expires_at: number
	created_at: string
}

const rowToClient = (row: ClientRow): OAuthClient => ({
	...row,
	redirect_uris: JSON.parse(row.redirect_uris) as string[],
	grant_types: JSON.parse(row.grant_types) as string[],
	response_types: JSON.parse(row.response_types) as string[],
})

export type RegisterClientInput = {
	client_name: string
	redirect_uris: string[]
	grant_types?: string[]
	response_types?: string[]
	token_endpoint_auth_method?: string
	scope?: string
	client_uri?: string
	software_id?: string
	software_version?: string
}

export type RegisteredClient = {
	client: OAuthClient
	client_secret_plain: string | null
}

export const registerClient = (
	input: RegisterClientInput,
	db: Database = openDb(),
): RegisteredClient => {
	const clientId = `mcp_${randomToken(12)}`
	const authMethod = input.token_endpoint_auth_method ?? 'none'
	const isPublic = authMethod === 'none'
	const clientSecretPlain = isPublic ? null : randomToken(32)
	const now = Math.floor(Date.now() / 1000)

	db.prepare(
		`INSERT INTO oauth_clients (
       client_id, client_secret, client_name, redirect_uris, grant_types,
       response_types, token_endpoint_auth_method, scope, client_uri,
       software_id, software_version, client_id_issued_at, client_secret_expires_at
     ) VALUES (
       @client_id, @client_secret, @client_name, @redirect_uris, @grant_types,
       @response_types, @token_endpoint_auth_method, @scope, @client_uri,
       @software_id, @software_version, @client_id_issued_at, @client_secret_expires_at
     )`,
	).run({
		client_id: clientId,
		client_secret: clientSecretPlain,
		client_name: input.client_name,
		redirect_uris: JSON.stringify(input.redirect_uris),
		grant_types: JSON.stringify(
			input.grant_types ?? ['authorization_code', 'refresh_token'],
		),
		response_types: JSON.stringify(input.response_types ?? ['code']),
		token_endpoint_auth_method: authMethod,
		scope: input.scope ?? null,
		client_uri: input.client_uri ?? null,
		software_id: input.software_id ?? null,
		software_version: input.software_version ?? null,
		client_id_issued_at: now,
		client_secret_expires_at: 0,
	})

	const client = getClient(clientId, db)
	if (!client) throw new Error('registerClient: row disappeared after insert')
	return { client, client_secret_plain: clientSecretPlain }
}

export const getClient = (
	clientId: string,
	db: Database = openDb(),
): OAuthClient | undefined => {
	const row = db
		.prepare<[string], ClientRow>(
			'SELECT * FROM oauth_clients WHERE client_id = ?',
		)
		.get(clientId)
	return row ? rowToClient(row) : undefined
}

export const listClients = (db: Database = openDb()): OAuthClient[] =>
	db
		.prepare<[], ClientRow>(
			'SELECT * FROM oauth_clients ORDER BY created_at DESC',
		)
		.all()
		.map(rowToClient)

export const deleteClient = (
	clientId: string,
	db: Database = openDb(),
): boolean =>
	db
		.prepare<[string]>('DELETE FROM oauth_clients WHERE client_id = ?')
		.run(clientId).changes > 0

// ───────────── Authorization Codes ─────────────

export type CreateAuthCodeInput = {
	client_id: string
	user_id: string
	/** Projektrollen der zustimmenden Person (aus dem Sitzungs-Cookie). */
	roles?: string[]
	code_challenge: string
	code_challenge_method?: string
	redirect_uri: string
	scopes?: string[]
	resource?: string
	ttl_seconds?: number
}

export const createAuthCode = (
	input: CreateAuthCodeInput,
	db: Database = openDb(),
): string => {
	const code = randomToken(32)
	const now = Math.floor(Date.now() / 1000)
	const expiresAt = now + (input.ttl_seconds ?? 600)
	db.prepare(
		`INSERT INTO oauth_authorization_codes (
       code, client_id, user_id, roles, code_challenge, code_challenge_method,
       redirect_uri, scopes, resource, expires_at
     ) VALUES (
       @code, @client_id, @user_id, @roles, @code_challenge, @code_challenge_method,
       @redirect_uri, @scopes, @resource, @expires_at
     )`,
	).run({
		code,
		client_id: input.client_id,
		user_id: input.user_id,
		roles: input.roles ? JSON.stringify(input.roles) : null,
		code_challenge: input.code_challenge,
		code_challenge_method: input.code_challenge_method ?? 'S256',
		redirect_uri: input.redirect_uri,
		scopes: input.scopes ? JSON.stringify(input.scopes) : null,
		resource: input.resource ?? null,
		expires_at: expiresAt,
	})
	return code
}

type AuthCodeRow = {
	code: string
	client_id: string
	user_id: string
	roles: string | null
	code_challenge: string
	code_challenge_method: string
	redirect_uri: string
	scopes: string | null
	resource: string | null
	expires_at: number
	used: 0 | 1
}

export const peekAuthCode = (
	code: string,
	db: Database = openDb(),
): AuthCode | undefined => {
	const row = db
		.prepare<[string], AuthCodeRow>(
			'SELECT * FROM oauth_authorization_codes WHERE code = ?',
		)
		.get(code)
	return row
		? {
				...row,
				roles: parseJsonArray(row.roles),
				scopes: parseJsonArray(row.scopes),
			}
		: undefined
}

/**
 * Markiert den Code als used in einer Transaktion. Wirft, wenn Code unbekannt,
 * bereits used, oder abgelaufen ist.
 */
export const consumeAuthCode = (
	code: string,
	db: Database = openDb(),
): AuthCode => {
	const row = db
		.prepare<[string], AuthCodeRow>(
			'SELECT * FROM oauth_authorization_codes WHERE code = ?',
		)
		.get(code)
	if (!row) throw new Error('invalid_grant: code not found')
	if (row.used === 1) throw new Error('invalid_grant: code already used')
	const now = Math.floor(Date.now() / 1000)
	if (row.expires_at < now) throw new Error('invalid_grant: code expired')
	db.prepare<[string]>(
		'UPDATE oauth_authorization_codes SET used = 1 WHERE code = ?',
	).run(code)
	return {
		...row,
		roles: parseJsonArray(row.roles),
		scopes: parseJsonArray(row.scopes),
	}
}

// ───────────── Tokens (Access + Refresh) ─────────────

export type IssueTokensInput = {
	client_id: string
	user_id: string
	roles: string[] | null
	scopes: string[] | null
	resource: string | null
	access_ttl_seconds?: number
	refresh_ttl_seconds?: number
}

export type IssuedTokens = {
	access_token: string
	refresh_token: string
	access_token_hash: string
	refresh_token_hash: string
	expires_in: number
}

export const issueTokens = (
	input: IssueTokensInput,
	db: Database = openDb(),
): IssuedTokens => {
	const accessToken = randomToken(32)
	const refreshToken = randomToken(32)
	const accessHash = sha256Hex(accessToken)
	const refreshHash = sha256Hex(refreshToken)
	const now = Math.floor(Date.now() / 1000)
	const accessTtl = input.access_ttl_seconds ?? 3600
	const refreshTtl = input.refresh_ttl_seconds ?? 30 * 24 * 3600

	const tx = db.transaction(() => {
		db.prepare(
			`INSERT INTO oauth_access_tokens (
         token_hash, client_id, user_id, roles, scopes, resource, expires_at
       ) VALUES (
         @token_hash, @client_id, @user_id, @roles, @scopes, @resource, @expires_at
       )`,
		).run({
			token_hash: accessHash,
			client_id: input.client_id,
			user_id: input.user_id,
			roles: input.roles ? JSON.stringify(input.roles) : null,
			scopes: input.scopes ? JSON.stringify(input.scopes) : null,
			resource: input.resource,
			expires_at: now + accessTtl,
		})

		db.prepare(
			`INSERT INTO oauth_refresh_tokens (
         token_hash, access_token_hash, client_id, user_id, roles, scopes, resource, expires_at
       ) VALUES (
         @token_hash, @access_token_hash, @client_id, @user_id, @roles, @scopes, @resource, @expires_at
       )`,
		).run({
			token_hash: refreshHash,
			access_token_hash: accessHash,
			client_id: input.client_id,
			user_id: input.user_id,
			roles: input.roles ? JSON.stringify(input.roles) : null,
			scopes: input.scopes ? JSON.stringify(input.scopes) : null,
			resource: input.resource,
			expires_at: now + refreshTtl,
		})
	})
	tx()

	return {
		access_token: accessToken,
		refresh_token: refreshToken,
		access_token_hash: accessHash,
		refresh_token_hash: refreshHash,
		expires_in: accessTtl,
	}
}

type AccessTokenRow = {
	token_hash: string
	client_id: string
	user_id: string
	roles: string | null
	scopes: string | null
	resource: string | null
	expires_at: number
	revoked: 0 | 1
}

export const verifyAccessToken = (
	rawToken: string,
	db: Database = openDb(),
): AccessToken | undefined => {
	const hash = sha256Hex(rawToken)
	const row = db
		.prepare<[string], AccessTokenRow>(
			'SELECT * FROM oauth_access_tokens WHERE token_hash = ?',
		)
		.get(hash)
	if (!row) return undefined
	if (row.revoked === 1) return undefined
	if (row.expires_at < Math.floor(Date.now() / 1000)) return undefined
	return {
		...row,
		roles: parseJsonArray(row.roles),
		scopes: parseJsonArray(row.scopes),
	}
}

type RefreshTokenRow = {
	token_hash: string
	access_token_hash: string | null
	client_id: string
	user_id: string
	roles: string | null
	scopes: string | null
	resource: string | null
	expires_at: number
	revoked: 0 | 1
	replaced_by_hash: string | null
}

/**
 * Tauscht einen Refresh-Token gegen ein neues Token-Paar aus (rotation).
 * Der alte Refresh-Token wird revoked und `replaced_by_hash` auf den neuen Hash gesetzt.
 * Der zugehörige alte Access-Token wird ebenfalls revoked.
 */
export const rotateRefreshToken = (
	rawRefreshToken: string,
	db: Database = openDb(),
): IssuedTokens => {
	const hash = sha256Hex(rawRefreshToken)
	const row = db
		.prepare<[string], RefreshTokenRow>(
			'SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?',
		)
		.get(hash)
	if (!row) throw new Error('invalid_grant: refresh token not found')
	if (row.revoked === 1) {
		throw new Error('invalid_grant: refresh token revoked')
	}
	if (row.expires_at < Math.floor(Date.now() / 1000)) {
		throw new Error('invalid_grant: refresh token expired')
	}

	const newTokens = issueTokens(
		{
			client_id: row.client_id,
			user_id: row.user_id,
			// Die Rollen wandern unveraendert mit. Ein Refresh ist KEINE neue
			// Zustimmung — wer seine Rollen neu holen will, meldet sich neu an.
			// Umgekehrt beendet ein Widerruf (revokeToken/deleteClient) den
			// Zugang sofort.
			roles: parseJsonArray(row.roles),
			scopes: parseJsonArray(row.scopes),
			resource: row.resource,
		},
		db,
	)

	const tx = db.transaction(() => {
		db.prepare<[string, string]>(
			'UPDATE oauth_refresh_tokens SET revoked = 1, replaced_by_hash = ? WHERE token_hash = ?',
		).run(newTokens.refresh_token_hash, hash)
		if (row.access_token_hash) {
			db.prepare<[string]>(
				'UPDATE oauth_access_tokens SET revoked = 1 WHERE token_hash = ?',
			).run(row.access_token_hash)
		}
	})
	tx()

	return newTokens
}

export const revokeToken = (
	rawToken: string,
	db: Database = openDb(),
): boolean => {
	const hash = sha256Hex(rawToken)
	const accessChanges = db
		.prepare<[string]>(
			'UPDATE oauth_access_tokens SET revoked = 1 WHERE token_hash = ?',
		)
		.run(hash).changes
	const refreshChanges = db
		.prepare<[string]>(
			'UPDATE oauth_refresh_tokens SET revoked = 1 WHERE token_hash = ?',
		)
		.run(hash).changes
	return accessChanges + refreshChanges > 0
}

export type ClientUsage = {
	client_id: string
	client_name: string
	active_access_tokens: number
	active_refresh_tokens: number
	last_token_at: string | null
}

export const listClientUsage = (
	user_id: string,
	db: Database = openDb(),
): ClientUsage[] => {
	return db
		.prepare<[string, string, string, string, string], ClientUsage>(
			`SELECT
         c.client_id,
         c.client_name,
         COALESCE((
           SELECT COUNT(*) FROM oauth_access_tokens at
           WHERE at.client_id = c.client_id AND at.user_id = ?
                 AND at.revoked = 0 AND at.expires_at > strftime('%s','now')
         ), 0) AS active_access_tokens,
         COALESCE((
           SELECT COUNT(*) FROM oauth_refresh_tokens rt
           WHERE rt.client_id = c.client_id AND rt.user_id = ?
                 AND rt.revoked = 0 AND rt.expires_at > strftime('%s','now')
         ), 0) AS active_refresh_tokens,
         (
           SELECT MAX(at.created_at) FROM oauth_access_tokens at
           WHERE at.client_id = c.client_id AND at.user_id = ?
         ) AS last_token_at
       FROM oauth_clients c
       WHERE EXISTS (
         SELECT 1 FROM oauth_access_tokens at
         WHERE at.client_id = c.client_id AND at.user_id = ?
       ) OR EXISTS (
         SELECT 1 FROM oauth_refresh_tokens rt
         WHERE rt.client_id = c.client_id AND rt.user_id = ?
       )
       ORDER BY last_token_at DESC NULLS LAST`,
		)
		.all(user_id, user_id, user_id, user_id, user_id)
}

export const revokeAllTokensForClientAndUser = (
	client_id: string,
	user_id: string,
	db: Database = openDb(),
): { access: number; refresh: number } => {
	const tx = db.transaction(() => {
		const access = db
			.prepare<[string, string]>(
				'UPDATE oauth_access_tokens SET revoked = 1 WHERE client_id = ? AND user_id = ? AND revoked = 0',
			)
			.run(client_id, user_id).changes
		const refresh = db
			.prepare<[string, string]>(
				'UPDATE oauth_refresh_tokens SET revoked = 1 WHERE client_id = ? AND user_id = ? AND revoked = 0',
			)
			.run(client_id, user_id).changes
		return { access, refresh }
	})
	return tx()
}

export const verifyClientSecret = (
	client: OAuthClient,
	providedSecret: string,
): boolean => {
	if (!client.client_secret) return false
	return client.client_secret === providedSecret
}

// ───────────── Pending Authorizations ─────────────

export type PendingAuthorization = {
	pending_id: string
	client_id: string
	redirect_uri: string
	scopes: string[] | null
	state: string | null
	code_challenge: string
	code_challenge_method: string
	resource: string | null
	expires_at: number
}

export type CreatePendingInput = {
	client_id: string
	redirect_uri: string
	scopes?: string[]
	state?: string
	code_challenge: string
	code_challenge_method?: string
	resource?: string
	ttl_seconds?: number
}

export const createPendingAuthorization = (
	input: CreatePendingInput,
	db: Database = openDb(),
): string => {
	const pendingId = randomToken(24)
	const now = Math.floor(Date.now() / 1000)
	db.prepare(
		`INSERT INTO oauth_pending_authorizations (
       pending_id, client_id, redirect_uri, scopes, state,
       code_challenge, code_challenge_method, resource, expires_at
     ) VALUES (
       @pending_id, @client_id, @redirect_uri, @scopes, @state,
       @code_challenge, @code_challenge_method, @resource, @expires_at
     )`,
	).run({
		pending_id: pendingId,
		client_id: input.client_id,
		redirect_uri: input.redirect_uri,
		scopes: input.scopes ? JSON.stringify(input.scopes) : null,
		state: input.state ?? null,
		code_challenge: input.code_challenge,
		code_challenge_method: input.code_challenge_method ?? 'S256',
		resource: input.resource ?? null,
		expires_at: now + (input.ttl_seconds ?? 600),
	})
	return pendingId
}

type PendingRow = {
	pending_id: string
	client_id: string
	redirect_uri: string
	scopes: string | null
	state: string | null
	code_challenge: string
	code_challenge_method: string
	resource: string | null
	expires_at: number
}

export const getPendingAuthorization = (
	pending_id: string,
	db: Database = openDb(),
): PendingAuthorization | undefined => {
	const row = db
		.prepare<[string], PendingRow>(
			'SELECT * FROM oauth_pending_authorizations WHERE pending_id = ?',
		)
		.get(pending_id)
	if (!row) return undefined
	if (row.expires_at < Math.floor(Date.now() / 1000)) {
		deletePendingAuthorization(pending_id, db)
		return undefined
	}
	return { ...row, scopes: parseJsonArray(row.scopes) }
}

export const deletePendingAuthorization = (
	pending_id: string,
	db: Database = openDb(),
): void => {
	db.prepare<[string]>(
		'DELETE FROM oauth_pending_authorizations WHERE pending_id = ?',
	).run(pending_id)
}
