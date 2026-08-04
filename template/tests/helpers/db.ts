import fs from 'node:fs'
import path from 'node:path'
import Database, { type Database as DatabaseType } from 'better-sqlite3'

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations')

/**
 * Frische In-Memory-Datenbank mit dem echten Schema: alle Migrations werden in
 * Dateinamen-Reihenfolge eingespielt. Damit testen wir gegen dasselbe Schema,
 * das auch produktiv laeuft, statt gegen eine Handschrift-Kopie.
 *
 * DATENSCHUTZ: Tests befuellen diese DB ausschliesslich mit erfundenen Namen
 * und `example.org`-Adressen. Echte Elterndaten haben im Repository nichts zu
 * suchen — auch nicht als Fixture.
 */
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

/**
 * Schneidet den `-- migrate:up`-Abschnitt heraus. Ab dem ENDE der Markerzeile,
 * damit dbmate-Direktiven hinter dem Marker (z.B.
 * `-- migrate:up transaction:false`) nicht als SQL auftauchen.
 */
const extractUpSection = (content: string): string | undefined => {
	const start = content.indexOf('-- migrate:up')
	if (start === -1) return undefined
	const lineEnd = content.indexOf('\n', start)
	const afterMarker = lineEnd === -1 ? '' : content.slice(lineEnd + 1)
	const end = afterMarker.indexOf('-- migrate:down')
	return end === -1 ? afterMarker : afterMarker.slice(0, end)
}
