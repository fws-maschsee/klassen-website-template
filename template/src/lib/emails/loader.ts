import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Email, LoadedEmail } from './types.js'

const DEFAULT_DIR = path.join(process.cwd(), 'emails')

/**
 * Slugs aller Rundmails im `emails/`-Verzeichnis. Dateien mit `_`-Praefix
 * gelten als Vorlagen und werden ignoriert. Sortiert nach neuesten zuerst —
 * die Slugs sind datumspraefixiert.
 */
export const listEmailSlugs = (dir: string = DEFAULT_DIR): string[] => {
	if (!fs.existsSync(dir)) return []
	return fs
		.readdirSync(dir)
		.filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
		.map((f) => f.replace(/\.ts$/, ''))
		.sort((a, b) => b.localeCompare(a))
}

export const loadEmail = async (
	slug: string,
	dir: string = DEFAULT_DIR,
): Promise<Email> => {
	const file = path.join(dir, `${slug}.ts`)
	if (!fs.existsSync(file)) {
		throw new Error(`Rundmail nicht gefunden: ${file}`)
	}
	const mod = (await import(pathToFileURL(file).href)) as { default?: Email }
	if (!mod.default) {
		throw new Error(`emails/${slug}.ts: default-Export fehlt`)
	}
	return mod.default
}

export const loadAllEmails = async (
	dir: string = DEFAULT_DIR,
): Promise<LoadedEmail[]> => {
	const out: LoadedEmail[] = []
	for (const slug of listEmailSlugs(dir)) {
		out.push({ slug, email: await loadEmail(slug, dir) })
	}
	return out
}
