/**
 * Konfiguration des Workers. Nicht-geheime Werte stehen in `wrangler.toml`
 * ([vars]), das Secret wird per `wrangler secret put` gesetzt.
 *
 * Ein Worker bedient genau eine Klasse und liegt im Repository dieser Klasse.
 * `CLASS_SLUG` sagt, welche das ist — und ist damit nicht nur Deko, sondern die
 * Grenze, an der Post für andere Klassen abgewiesen wird (siehe `address.ts`).
 */
import { isSlug } from './address.js'

export interface Env {
	/** Basis-URL der App dieser Klasse, ohne Schrägstrich am Ende. */
	APP_BASE_URL: string
	/** Listen-Domain ohne Klassen-Label, z.B. `lists.example.org`. */
	LIST_DOMAIN: string
	/** Klasse, die dieser Worker bedient, z.B. `klasse-musterfrau`. */
	CLASS_SLUG: string
	/** Geteiltes HMAC-Secret; in der App als `LIST_WEBHOOK_SECRET` hinterlegt. */
	LIST_WEBHOOK_SECRET: string
	/** Optionales Größenlimit in Bytes (Default siehe `DEFAULT_MAX_MESSAGE_BYTES`). */
	MAX_MESSAGE_BYTES?: string
	/** Optionales Timeout für den App-Aufruf in Millisekunden. */
	REQUEST_TIMEOUT_MS?: string
}

/** Pfad des Webhooks in der App. */
export const INCOMING_PATH = '/api/lists/incoming'

/**
 * Cloudflare weist eingehende Mails über 25 MiB schon vor dem Worker ab, der
 * Worker sieht sie also nie. Unser eigenes Limit liegt bewusst deutlich
 * darunter: Die App muss die Mail vollständig in den Speicher lesen, parsen und
 * anschließend an jeden Empfänger einzeln über SES ausliefern — eine 25-MiB-Mail
 * an 30 Eltern sind 750 MiB ausgehend. 10 MiB roh (~7 MiB Anhänge nach
 * Base64-Aufblähung) ist für Elternpost reichlich; größere Dateien gehören auf
 * die Website und nicht in einen Verteiler.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024

/**
 * Timeout für den App-Aufruf. Ein hängender Server darf nicht das Zeitbudget
 * des Workers aufbrauchen — lieber früh abbrechen und den absendenden
 * Mailserver (nach dem temporären Fehler) später erneut zustellen lassen.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

const positiveInt = (value: string | undefined, fallback: number): number => {
	if (value === undefined) return fallback
	const parsed = Number.parseInt(value, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export type Config = {
	incomingUrl: string
	listDomain: string
	classSlug: string
	secret: string
	maxMessageBytes: number
	requestTimeoutMs: number
}

/**
 * Liest die Konfiguration und wirft bei fehlenden oder unbrauchbaren Werten.
 * Werfen ist hier richtig: Eine Fehlkonfiguration ist unser Problem, nicht das
 * des Absenders, und darf keine Mail dauerhaft zurückweisen (siehe `index.ts`).
 */
export const readConfig = (env: Env): Config => {
	const missing = (
		[
			'APP_BASE_URL',
			'LIST_DOMAIN',
			'CLASS_SLUG',
			'LIST_WEBHOOK_SECRET',
		] as const
	).filter((key) => !env[key])
	if (missing.length > 0) {
		throw new Error(`Worker unvollständig konfiguriert: ${missing.join(', ')}`)
	}
	if (!isSlug(env.CLASS_SLUG)) {
		throw new Error(
			`CLASS_SLUG ist kein gültiges Klassen-Label: ${JSON.stringify(env.CLASS_SLUG)}`,
		)
	}

	// Wirft bei kaputter URL. Lieber hier als beim fetch — und https ist Pflicht,
	// weil die Mail im Klartext durch die Leitung ginge.
	const base = new URL(env.APP_BASE_URL)
	if (base.protocol !== 'https:') {
		throw new Error(`APP_BASE_URL ist nicht https: ${env.APP_BASE_URL}`)
	}

	return {
		incomingUrl: `${env.APP_BASE_URL.replace(/\/+$/, '')}${INCOMING_PATH}`,
		listDomain: env.LIST_DOMAIN,
		classSlug: env.CLASS_SLUG,
		secret: env.LIST_WEBHOOK_SECRET,
		maxMessageBytes: positiveInt(
			env.MAX_MESSAGE_BYTES,
			DEFAULT_MAX_MESSAGE_BYTES,
		),
		requestTimeoutMs: positiveInt(
			env.REQUEST_TIMEOUT_MS,
			DEFAULT_REQUEST_TIMEOUT_MS,
		),
	}
}
