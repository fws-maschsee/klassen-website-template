import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	consumeAuthCode,
	createAuthCode,
	issueTokens,
	registerClient,
	rotateRefreshToken,
	verifyAccessToken,
} from '../../src/lib/db/oauth.js'
import { createTestDb } from '../helpers/db.js'

/**
 * Ein MCP-Client bringt kein Sitzungs-Cookie mit, sondern ein Bearer-Token.
 * Ob er schreiben darf, kann deshalb nur an dem haengen, was beim Zustimmen
 * in das Token gewandert ist. Diese Kette darf an keiner Stelle reissen —
 * am wenigsten beim Refresh, der stuendlich passiert.
 */
describe('Rollen an den OAuth-Tokens', () => {
	let db: Database
	let clientId: string

	beforeEach(() => {
		db = createTestDb()
		clientId = registerClient(
			{ client_name: 'Testclient', redirect_uris: ['https://example.org/cb'] },
			db,
		).client.client_id
	})

	const codeFor = (roles: string[]): string =>
		createAuthCode(
			{
				client_id: clientId,
				user_id: 'sub-1',
				roles,
				code_challenge: 'challenge',
				redirect_uri: 'https://example.org/cb',
				scopes: ['mcp'],
			},
			db,
		)

	it('traegt die Rollen von der Zustimmung bis ins Access-Token', () => {
		const consumed = consumeAuthCode(codeFor(['mitglied', 'admin']), db)
		expect(consumed.roles).toEqual(['mitglied', 'admin'])

		const issued = issueTokens(
			{
				client_id: clientId,
				user_id: consumed.user_id,
				roles: consumed.roles,
				scopes: consumed.scopes,
				resource: null,
			},
			db,
		)
		expect(verifyAccessToken(issued.access_token, db)?.roles).toEqual([
			'mitglied',
			'admin',
		])
	})

	it('behaelt die Rollen beim Refresh', () => {
		const consumed = consumeAuthCode(codeFor(['admin']), db)
		const issued = issueTokens(
			{
				client_id: clientId,
				user_id: consumed.user_id,
				roles: consumed.roles,
				scopes: consumed.scopes,
				resource: null,
			},
			db,
		)
		const rotated = rotateRefreshToken(issued.refresh_token, db)
		expect(verifyAccessToken(rotated.access_token, db)?.roles).toEqual([
			'admin',
		])
		// Das alte Access-Token ist mit der Rotation erledigt.
		expect(verifyAccessToken(issued.access_token, db)).toBeUndefined()
	})

	it('liefert fuer Tokens ohne Rollen keine Rollen, nicht alle', () => {
		// Zeilen aus der Zeit vor der Migration `add_roles_to_oauth_tokens`.
		const issued = issueTokens(
			{
				client_id: clientId,
				user_id: 'sub-alt',
				roles: null,
				scopes: ['mcp'],
				resource: null,
			},
			db,
		)
		expect(verifyAccessToken(issued.access_token, db)?.roles).toBeNull()
	})
})
