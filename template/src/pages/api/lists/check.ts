import type { APIRoute } from 'astro'
import { checkListSender } from '../../../lib/lists/incoming.js'
import {
	HEADER_SIGNATURE,
	HEADER_TIMESTAMP,
	verifyListSignature,
} from '../../../lib/lists/signature.js'

export const prerender = false

type CheckBody = {
	list?: unknown
	from?: unknown
}

/**
 * Vorabpruefung: "Darf dieser Absender an diese Liste senden?"
 *
 * OPTIONAL. Der Worker in `email-worker/` ruft diesen Endpunkt NICHT auf: Er
 * reicht die Mail durch und liest die Berechtigung am HTTP-Status von
 * `/api/lists/incoming` ab (403 -> Ablehnung beim Absender). Der Endpunkt
 * bleibt trotzdem, weil er zwei Dinge kann, die `/incoming` nicht kann:
 *
 *  - die Frage "warum kommt meine Mail nicht durch?" beantworten, ohne dass
 *    jemand eine Mail verschicken muss,
 *  - einen Worker bedienen, der schon beim SMTP-Handshake ablehnen moechte,
 *    bevor er den Nachrichtenrumpf ueberhaupt entgegennimmt.
 *
 * VERTRAG:
 *
 *   POST /api/lists/check
 *   Content-Type: application/json
 *   Body: {"list": "eltern", "from": "jemand@example.org"}
 *   Header:
 *     X-List-Timestamp  Unix-Sekunden
 *     X-List-Signature  hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))
 *                       — rawBody ist der JSON-Body, byte-genau wie gesendet
 *
 *   Antworten:
 *     200 {"allowed": true,  "list": "eltern", "label": "...", "recipients": 23}
 *     403 {"allowed": false, "reason": "..."}   -> Worker lehnt die Mail ab
 *     400 fehlende Felder
 *     401 Signatur fehlt/ungueltig
 *
 * Die Antwort nennt bewusst KEINE Empfaengeradressen, nur ihre Anzahl.
 */
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

	let body: CheckBody
	try {
		body = JSON.parse(rawBody.toString('utf-8')) as CheckBody
	} catch {
		return Response.json({ error: 'ungueltiges JSON' }, { status: 400 })
	}

	const list = typeof body.list === 'string' ? body.list : null
	const from = typeof body.from === 'string' ? body.from : null
	if (!list || !from) {
		return Response.json(
			{ error: 'Felder "list" und "from" sind Pflicht' },
			{ status: 400 },
		)
	}

	const result = checkListSender(list, from)
	return Response.json(result, { status: result.allowed ? 200 : 403 })
}
