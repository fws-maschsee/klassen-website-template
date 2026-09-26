import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
	assertInstanceMatches,
	checkInstance,
	getRecordedInstance,
	recordInstanceIfEmpty,
} from '../../src/lib/db/instance.js'
import { createTestDb } from '../helpers/db.js'

let db: Database
const originalEnv = process.env.MCP_INSTANCE_NAME

beforeEach(() => {
	db = createTestDb()
})

afterEach(() => {
	if (originalEnv === undefined) delete process.env.MCP_INSTANCE_NAME
	else process.env.MCP_INSTANCE_NAME = originalEnv
})

describe('Instanz-Bindung', () => {
	test('frische Datenbank uebernimmt den konfigurierten Namen', () => {
		process.env.MCP_INSTANCE_NAME = 'klasse-musterfrau'
		expect(getRecordedInstance(db)).toBeNull()
		assertInstanceMatches(db)
		expect(getRecordedInstance(db)).toBe('klasse-musterfrau')
	})

	test('der einmal geschriebene Name wird nicht ueberschrieben', () => {
		recordInstanceIfEmpty('klasse-musterfrau', db)
		expect(recordInstanceIfEmpty('klasse-nachbar', db)).toBe(
			'klasse-musterfrau',
		)
		expect(getRecordedInstance(db)).toBe('klasse-musterfrau')
	})

	test('Mismatch zwischen Datei und Konfiguration bricht den Start ab', () => {
		recordInstanceIfEmpty('klasse-nachbar', db)
		process.env.MCP_INSTANCE_NAME = 'klasse-musterfrau'

		expect(checkInstance(db).ok).toBe(false)
		expect(() => assertInstanceMatches(db)).toThrow(/Instanz-Konflikt/)
	})

	test('passende Konfiguration laeuft durch', () => {
		recordInstanceIfEmpty('klasse-musterfrau', db)
		process.env.MCP_INSTANCE_NAME = 'klasse-musterfrau'
		expect(() => assertInstanceMatches(db)).not.toThrow()
	})
})
