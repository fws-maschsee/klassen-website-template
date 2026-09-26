import type { APIRoute } from 'astro'
import { instanceName } from '../../../lib/db/instance.js'
import {
	handleIncomingListMail,
	statusForResult,
} from '../../../lib/lists/incoming.js'
import {
	HEADER_CLASS,
	HEADER_ENVELOPE_FROM,
	HEADER_LIST_NAME,
	HEADER_MESSAGE_ID,
	HEADER_SIGNATURE,
	HEADER_TIMESTAMP,
	verifyListSignature,
} from '../../../lib/lists/signature.js'
import { syncMembersFromZitadel } from '../../../server/auth/mirror.js'

export const prerender = false

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

const maxBytes = (): number =>
	Number.parseInt(process.env.MAX_MESSAGE_BYTES ?? `${DEFAULT_MAX_BYTES}`, 10)

const megabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

export const POST: APIRoute = async ({ request }) => {
	const rawBody = Buffer.from(await request.arrayBuffer())

	const sig = verifyListSignature({
		secret: process.env.LIST_WEBHOOK_SECRET,
		timestamp: request.headers.get(HEADER_TIMESTAMP),
		signature: request.headers.get(HEADER_SIGNATURE),
		rawBody,
	})
	if (!sig.ok) {
		return Response.json({ error: sig.reason }, { status: 401 })
	}

	const listName = request.headers.get(HEADER_LIST_NAME)
	if (!listName) {
		return Response.json(
			{ error: `Header ${HEADER_LIST_NAME} fehlt` },
			{ status: 400 },
		)
	}

	const className = request.headers.get(HEADER_CLASS)
	if (className && className !== instanceName()) {
		console.error(
			`[lists/incoming] Mail für Klasse "${className}" bei Instanz "${instanceName()}" abgewiesen - Routing-Regel prüfen`,
		)
		return Response.json(
			{ reason: 'Diese Adresse gehört nicht zu dieser Klasse.' },
			{ status: 404 },
		)
	}

	const envelopeFrom = request.headers.get(HEADER_ENVELOPE_FROM)
	if (!envelopeFrom) {
		return Response.json(
			{ error: `Header ${HEADER_ENVELOPE_FROM} fehlt` },
			{ status: 400 },
		)
	}

	const limit = maxBytes()
	if (rawBody.length > limit) {
		return Response.json(
			{
				reason: `Nachricht zu groß (${megabytes(rawBody.length)} MB, erlaubt sind ${megabytes(limit)} MB). Bitte große Anhänge verlinken statt anhängen.`,
			},
			{ status: 413 },
		)
	}

	try {
		const mirror = await syncMembersFromZitadel()
		if (mirror.added || mirror.updated || mirror.removed) {
			console.log(
				`[lists] Empfaenger abgeglichen: +${mirror.added} ~${mirror.updated} -${mirror.removed} (${mirror.total} mit Grant)`,
			)
		}
	} catch (error) {
		console.error(
			`[lists] Abgleich mit ZITADEL fehlgeschlagen, verteile mit dem letzten Stand: ${(error as Error).message}`,
		)
	}

	try {
		const result = await handleIncomingListMail(rawBody, {
			listName,
			envelopeFrom,
			messageId: request.headers.get(HEADER_MESSAGE_ID),
		})
		return Response.json(result, { status: statusForResult(result) })
	} catch (err) {
		console.error('[lists/incoming] unerwarteter Fehler', err)
		return Response.json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		)
	}
}
