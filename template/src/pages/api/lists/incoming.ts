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

/**
 * Eingang für Listenmails aus dem Cloudflare-Email-Worker.
 *
 * Der maßgebliche Vertrag steht in `email-worker/README.md`; diese Datei ist
 * die App-Seite davon. Kurzfassung:
 *
 *   POST /api/lists/incoming
 *   Content-Type: message/rfc822
 *   Body: die ROHE, unveränderte Mail — die Signatur deckt genau diese Bytes ab
 *   Header:
 *     X-List-Class         Klassen-Label, z.B. "klasse-musterfrau"
 *     X-List-Name          Listen-Localpart, z.B. "eltern"
 *     X-List-Recipient     vollständige Empfängeradresse (nur informativ)
 *     X-List-Envelope-From SMTP MAIL FROM — hierauf wird autorisiert
 *     X-List-Message-Id    Message-ID der Mail, falls vorhanden
 *     X-List-Timestamp     Unix-Sekunden
 *     X-List-Signature     hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))
 *
 *   202 verteilt · 200 angenommen, aber bewusst nicht verteilt ·
 *   403 abgelehnt · 404 Liste unbekannt · 413 zu groß ·
 *   401 Signatur ungültig · 500 Störung (Worker stellt später erneut zu)
 *
 * Bei 403/404/413 liest der Worker `reason` aus dem JSON und gibt den Text dem
 * Absender in der SMTP-Antwort zurück. Er darf deshalb nichts Vertrauliches
 * enthalten.
 */

/**
 * Eigenes Größenlimit. Der Worker prüft bereits gegen sein `MAX_MESSAGE_BYTES`
 * (Default 10 MiB); diese Prüfung ist die zweite Verteidigungslinie für den
 * Fall, dass jemand direkt auf den Endpunkt zugreift oder die Worker-Variable
 * zu großzügig steht. Jede angenommene Mail wird vollständig geparst und
 * anschließend an jeden Empfänger einzeln über SES ausgeliefert.
 */
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
		// 401 gilt beim Worker als Störung auf UNSERER Seite, nicht als
		// Absenderfehler: Er wirft und der einliefernde Server stellt später
		// erneut zu. Deshalb hier auch kein `reason` für den Absender.
		return Response.json({ error: sig.reason }, { status: 401 })
	}

	const listName = request.headers.get(HEADER_LIST_NAME)
	if (!listName) {
		return Response.json(
			{ error: `Header ${HEADER_LIST_NAME} fehlt` },
			{ status: 400 },
		)
	}

	// Zweite Prüfung der Klasse. Der Worker prüft sie bereits gegen sein
	// CLASS_SLUG; hier kostet die Wiederholung nichts und deckt eine falsch
	// gesetzte Worker-Variable auf, bevor Elternpost der einen Klasse in den
	// Daten der anderen landet.
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

	// Empfaenger frisch aus ZITADEL spiegeln, BEVOR verteilt wird.
	//
	// Hier und nicht in `handleIncomingListMail`: die Verteilungslogik bleibt
	// damit eine reine Funktion auf der Datenbank und ohne Netzzugriff
	// testbar.
	//
	// Ein Fehler bricht den Eingang NICHT ab. Eine Mail, die wegen einer
	// Stoerung bei ZITADEL gar nicht erst verteilt wird, faellt niemandem auf
	// — verteilt mit dem letzten bekannten Stand faellt hoechstens ein
	// fehlender Neuzugang auf, und der Fehler steht im Log. Das ist die
	// Richtung, in die man sich hier irren will.
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
		// 5xx heißt für den Worker "später erneut zustellen" - genau richtig für
		// einen unerwarteten Fehler auf unserer Seite.
		console.error('[lists/incoming] unerwarteter Fehler', err)
		return Response.json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		)
	}
}
