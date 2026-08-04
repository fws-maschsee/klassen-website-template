/**
 * Der Aufruf an die App: ein einziger POST mit der rohen Mail.
 *
 * Der Worker trifft keine inhaltliche Entscheidung — er kennt weder Listen noch
 * Mitglieder. Er übersetzt zwischen SMTP und HTTP und macht aus der Antwort der
 * App einen SMTP-Statuscode. Die App ist die alleinige Quelle der Wahrheit:
 * unbekannte Liste oder unberechtigter Absender -> 403 -> der Worker weist die
 * Mail ab.
 *
 * Der vollständige Vertrag steht in `README.md`.
 */
import type { ParsedRecipient } from './address.js'
import type { Config } from './env.js'
import { computeSignature, currentTimestamp } from './signature.js'

/**
 * Antwort der App, so wie der Worker sie versteht. Maßgeblich ist der
 * HTTP-Status, nicht der Body — der Body liefert nur den Klartext für die
 * SMTP-Ablehnung.
 */
export type Verdict =
	/** 2xx — angenommen. Ob die App verteilt oder bewusst verwirft, ist ihre Sache. */
	| { kind: 'accepted'; status: number }
	/** 403/404/413 — dauerhaft abzulehnen, mit Begründung für den Absender. */
	| { kind: 'rejected'; reason: string }

/**
 * Signalisiert einen Zustand, der sich von selbst erledigen kann (App down,
 * Timeout, 5xx, Fehlkonfiguration). Führt in `index.ts` zu einer Exception und
 * damit zu einem temporären SMTP-Fehler — die Mail bleibt in der Warteschlange
 * des absendenden Servers.
 */
export class TemporaryFailure extends Error {}

/**
 * Entfernt alles, was in einem HTTP-Header nichts zu suchen hat. Klassen- und
 * Listen-Label sind bereits streng validiert; die Envelope-Adresse und die
 * Message-ID stammen dagegen vom Absender und werden hier entschärft
 * (Header-Injection über CR/LF).
 *
 * Nur druckbares ASCII bleibt übrig. Adressen und Message-IDs sind laut
 * RFC 5321 ohnehin ASCII; alles andere fliegt raus, statt es zu maskieren.
 */
export const headerSafe = (value: string, maxLength = 320): string =>
	value.replace(/[^ -~]/g, '').slice(0, maxLength)

const TRANSLITERATION: Record<string, string> = {
	ä: 'ae',
	ö: 'oe',
	ü: 'ue',
	Ä: 'Ae',
	Ö: 'Oe',
	Ü: 'Ue',
	ß: 'ss',
}

/**
 * Bereitet einen Text für die SMTP-Antwortzeile auf.
 *
 * SMTP-Statustexte sind ohne die SMTPUTF8-Erweiterung reines ASCII, und wir
 * wissen nicht, was der einliefernde Server kann. Statt Umlaute einfach zu
 * löschen („zu groß" -> „zu gro") werden sie umgeschrieben — der Text landet in
 * der Unzustellbarkeitsnachricht, die ein Elternteil zu lesen bekommt, und soll
 * dort verständlich sein.
 */
export const smtpSafe = (value: string, maxLength = 200): string =>
	value
		.replace(/[äöüÄÖÜß]/g, (character) => TRANSLITERATION[character])
		.replace(/[^ -~]/g, '')
		.trim()
		.slice(0, maxLength)

/** Grund aus der App-Antwort, oder ein Standardtext, wenn sie keinen liefert. */
const rejectReason = (text: string, fallback: string): string =>
	smtpSafe(text) || smtpSafe(fallback)

/** Holt `reason` aus einer JSON-Antwort; sonst gilt der Body als Klartext. */
const reasonOf = (body: string): string => {
	try {
		const parsed: unknown = JSON.parse(body)
		if (parsed && typeof parsed === 'object' && 'reason' in parsed) {
			const reason = (parsed as { reason: unknown }).reason
			if (typeof reason === 'string') return reason
		}
	} catch {
		// kein JSON — Body unverändert verwenden
	}
	return body
}

/**
 * Übergibt die rohe RFC822-Mail an die App.
 *
 * Metadaten wandern in `X-List-*`-Header, damit der Body byteweise das bleibt,
 * was der Absender geschickt hat — die Signatur deckt genau diese Bytes ab.
 *
 * `X-List-Envelope-From` ist der Envelope-Absender (SMTP `MAIL FROM`) und damit
 * die einzige halbwegs belastbare Absenderangabe; der `From:`-Header im Body
 * ist frei wählbar und darf für die Berechtigung nicht herangezogen werden.
 *
 * Übersetzung der Antwort:
 *   2xx  -> angenommen
 *   403  -> Absender nicht berechtigt / Liste inaktiv
 *   404  -> Liste unbekannt
 *   413  -> die App hat ein eigenes, strengeres Größenlimit
 *   401  -> Signatur stimmt nicht: unser Konfigurationsfehler, kein Absenderfehler
 *   Rest -> temporär
 */
export const deliver = async (
	config: Config,
	recipient: ParsedRecipient,
	envelopeFrom: string,
	messageId: string | null,
	raw: Uint8Array,
): Promise<Verdict> => {
	const timestamp = currentTimestamp()
	const signature = await computeSignature(config.secret, timestamp, raw)

	let response: Response
	try {
		response = await fetch(config.incomingUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'message/rfc822',
				'X-List-Class': recipient.class,
				'X-List-Name': recipient.list,
				'X-List-Recipient': headerSafe(recipient.recipient),
				'X-List-Envelope-From': headerSafe(envelopeFrom),
				...(messageId ? { 'X-List-Message-Id': headerSafe(messageId) } : {}),
				'X-List-Timestamp': timestamp,
				'X-List-Signature': signature,
			},
			body: raw,
			signal: AbortSignal.timeout(config.requestTimeoutMs),
		})
	} catch (error) {
		// Netzfehler, DNS, Timeout: die App ist gerade nicht da. Kein Grund, die
		// Mail wegzuwerfen oder dem Absender die Schuld zu geben.
		throw new TemporaryFailure(
			`App nicht erreichbar (${config.incomingUrl}): ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	const body = await response.text().catch(() => '')
	if (response.ok) return { kind: 'accepted', status: response.status }
	if (
		response.status === 403 ||
		response.status === 404 ||
		response.status === 413
	) {
		return {
			kind: 'rejected',
			reason: rejectReason(reasonOf(body), 'Nachricht abgelehnt'),
		}
	}
	throw new TemporaryFailure(
		`App antwortete ${response.status}: ${body.slice(0, 200)}`,
	)
}
