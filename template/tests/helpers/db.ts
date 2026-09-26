import fs from 'node:fs'
import path from 'node:path'
import Database, { type Database as DatabaseType } from 'better-sqlite3'

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations')

export const createTestDb = (): DatabaseType => {
	const db = new Database(':memory:')
	db.pragma('foreign_keys = ON')

	const files = fs
		.readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith('.sql'))
		.sort()

	for (const file of files) {
		const upSection = extractUpSection(
			fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'),
		)
		if (!upSection) {
			throw new Error(`Migration ${file} hat keinen -- migrate:up-Abschnitt`)
		}
		db.exec(upSection)
	}
	return db
}

const extractUpSection = (content: string): string | undefined => {
	const start = content.indexOf('-- migrate:up')
	if (start === -1) return undefined
	// Ab Zeilenende: dbmate-Optionen hinter dem Marker (transaction:false) sind kein SQL.
	const lineEnd = content.indexOf('\n', start)
	const afterMarker = lineEnd === -1 ? '' : content.slice(lineEnd + 1)
	const end = afterMarker.indexOf('-- migrate:down')
	return end === -1 ? afterMarker : afterMarker.slice(0, end)
}
