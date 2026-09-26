import { isSlug } from './address.js'

export interface Env {
	APP_BASE_URL: string
	LIST_DOMAIN: string
	CLASS_SLUG: string
	LIST_WEBHOOK_SECRET: string
	MAX_MESSAGE_BYTES?: string
	REQUEST_TIMEOUT_MS?: string
}

export const INCOMING_PATH = '/api/lists/incoming'

export const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024

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
