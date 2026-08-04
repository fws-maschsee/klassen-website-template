import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Der Kern der Autorisierung, gegen den echten MCP-Server gemessen: ein Zugang
 * mit `mitglied` darf lesen, aber nicht schreiben; ein Zugang mit `admin`
 * darf beides. Geprueft wird nicht die Hilfsfunktion, sondern der Weg, den ein
 * MCP-Client tatsaechlich nimmt — `tools/call` ueber einen Transport.
 *
 * Die Datenbank ist eine Wegwerf-Datei mit dem echten Schema; `openDb()`
 * merkt sich die erste Verbindung, deshalb wird `DB_PATH` gesetzt, BEVOR
 * irgendein Modul importiert wird, das sie oeffnet.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-guard-'))
const dbFile = path.join(tmpDir, 'test.db')

process.env.DB_PATH = dbFile
process.env.MCP_INSTANCE_NAME = 'klasse-musterfrau'

// biome-ignore lint/suspicious/noExplicitAny: erst nach dem Setzen von DB_PATH importiert
let buildMcpServer: any

const applyMigrations = (): void => {
	const dir = path.join(process.cwd(), 'db', 'migrations')
	// Denselben Weg wie tests/helpers/db.ts nehmen, nur auf eine Datei statt
	// nach :memory: — der MCP-Server oeffnet die Datei selbst.
	const db = new Database(dbFile)
	for (const file of fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		const content = fs.readFileSync(path.join(dir, file), 'utf-8')
		const start = content.indexOf('-- migrate:up')
		const lineEnd = content.indexOf('\n', start)
		const after = content.slice(lineEnd + 1)
		const end = after.indexOf('-- migrate:down')
		db.exec(end === -1 ? after : after.slice(0, end))
	}
	db.close()
}

const connect = async (roles: string[]): Promise<Client> => {
	const server = buildMcpServer({ userId: 'test-user', roles })
	const client = new Client({ name: 'test', version: '0' })
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair()
	await Promise.all([
		server.connect(serverTransport),
		client.connect(clientTransport),
	])
	return client
}

const textOf = (result: unknown): string => {
	const content = (result as { content?: unknown }).content
	return (Array.isArray(content) ? content : [])
		.map((part) => (part as { text?: string }).text ?? '')
		.join('\n')
}

beforeAll(async () => {
	applyMigrations()
	buildMcpServer = (await import('../../src/server/mcp/server.js'))
		.buildMcpServer
})

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('MCP-Zugriffsschutz', () => {
	it('bietet alle Werkzeuge beiden Rollen an', async () => {
		// Sichtbar bleiben sie, damit ein abgelehnter Aufruf eine Begruendung
		// bekommt statt "unbekanntes Werkzeug".
		const client = await connect(['mitglied'])
		const names = (await client.listTools()).tools.map((t) => t.name)
		expect(names).toContain('list_mailing_lists')
		expect(names).toContain('list_mitglieder')
		expect(names).toContain('upsert_mitglied')
		await client.close()
	})

	it('laesst mitglied die Verteiler und Gruppen sehen', async () => {
		// Der Kern der Trennung: welche Verteiler gibt es, wen erreichen sie.
		// Diese Frage beantwortet man vor jedem Absenden, und sie braucht keine
		// einzige fremde Adresse.
		const client = await connect(['mitglied'])
		for (const name of ['list_mailing_lists', 'list_groups']) {
			const result = await client.callTool({ name, arguments: {} })
			expect(result.isError).toBeFalsy()
		}
		await client.close()
	})

	it('verweigert mitglied die Personendaten', async () => {
		const client = await connect(['mitglied'])
		for (const name of ['list_mitglieder', 'search_mitglieder']) {
			const result = await client.callTool({ name, arguments: {} })
			expect(result.isError, name).toBe(true)
			expect(textOf(result)).toContain('admin')
		}
		await client.close()
	})

	it('weist mitglied beim Schreiben ab und aendert nichts', async () => {
		const client = await connect(['mitglied'])
		const result = await client.callTool({
			name: 'upsert_mitglied',
			arguments: {
				first_name: 'Test',
				last_name: 'Person',
			},
		})
		expect(result.isError).toBe(true)
		expect(textOf(result)).toContain('admin')
		await client.close()

		// Und es ist wirklich nichts entstanden.
		const admin = await connect(['admin'])
		const listed = await admin.callTool({
			name: 'list_mitglieder',
			arguments: {},
		})
		expect(textOf(listed)).not.toContain('Test')
		await admin.close()
	})

	it('laesst admin schreiben und lesen', async () => {
		const client = await connect(['admin', 'mitglied'])
		const result = await client.callTool({
			name: 'upsert_mitglied',
			arguments: {
				first_name: 'Anna',
				last_name: 'Beispiel',
			},
		})
		expect(result.isError).toBeFalsy()
		expect(textOf(result)).toContain('anna-beispiel')

		const listed = await client.callTool({
			name: 'list_mitglieder',
			arguments: {},
		})
		expect(listed.isError).toBeFalsy()
		expect(textOf(listed)).toContain('anna-beispiel')
		await client.close()
	})

	it('weist einen Zugang ganz ohne Rollen ueberall ab', async () => {
		// Tokens von vor der Rollen-Migration haben keine Rollen. Lesen der
		// Verteiler ja, Personendaten und Aenderungen nein — sichere Richtung.
		const client = await connect([])
		const write = await client.callTool({
			name: 'delete_mitglied',
			arguments: { id: 'anna-beispiel' },
		})
		expect(write.isError).toBe(true)
		const persons = await client.callTool({
			name: 'list_mitglieder',
			arguments: {},
		})
		expect(persons.isError).toBe(true)
		await client.close()
	})

	it('sperrt einen Zugang ohne jede Rolle auch beim Lesen aus', async () => {
		// Ein Bearer-Token ueberlebt die Person: wer die Klasse verlaesst,
		// verliert seinen Grant, sein Token bleibt aber gueltig. Ohne diese
		// Pruefung koennte er weiter aufzaehlen, welche Verteiler es gibt.
		const client = await connect([])
		const result = await client.callTool({
			name: 'list_mailing_lists',
			arguments: {},
		})
		expect(result.isError).toBe(true)
		await client.close()
	})

	it('meldet die eigenen Rechte in get_instance_info', async () => {
		const admin = await connect(['admin'])
		const a = JSON.parse(
			textOf(
				await admin.callTool({ name: 'get_instance_info', arguments: {} }),
			),
		)
		expect(a.may_edit).toBe(true)
		expect(a.may_see_personal_data).toBe(true)
		expect(a.roles).toEqual(['admin'])
		expect(a.auth_provider).toBe('zitadel')
		await admin.close()

		const leser = await connect(['mitglied'])
		const m = JSON.parse(
			textOf(
				await leser.callTool({ name: 'get_instance_info', arguments: {} }),
			),
		)
		expect(m.may_edit).toBe(false)
		expect(m.may_see_personal_data).toBe(false)
		await leser.close()
	})
})
