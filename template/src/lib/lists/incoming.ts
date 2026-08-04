import type { Database } from 'better-sqlite3'
import { simpleParser } from 'mailparser'
import { enqueueListMessage } from '../db/listQueue.js'
import {
	getMailingList,
	isSenderAllowed,
	normalizeEmail,
	resolveListRecipients,
} from '../db/mailingLists.js'

/**
 * Ergebnis der Eingangsverarbeitung. Die vier Fälle sind bewusst unterschieden,
 * weil der Cloudflare-Email-Worker auf jeden anders reagiert (siehe
 * `email-worker/README.md`):
 *
 *   enqueued     -> 202, angenommen und verteilt
 *   skipped      -> 200, angenommen, aber bewusst NICHT verteilt (Schleife,
 *                   Abwesenheitsnotiz, keine Empfänger). Der Worker akzeptiert
 *                   die Mail; eine Ablehnung gegenüber einem Autoresponder
 *                   erzeugt nur Ping-Pong.
 *   unknown_list -> 404, die Liste gibt es nicht. Der Worker weist die Mail
 *                   beim Absender ab.
 *   rejected     -> 403, Liste inaktiv oder Absender nicht berechtigt. Ebenfalls
 *                   Ablehnung beim Absender.
 *
 * `reason` landet über den Worker in der Unzustellbarkeitsnachricht, die ein
 * Elternteil zu lesen bekommt. Die Texte sind deshalb deutsch, verständlich und
 * enthalten nichts Vertrauliches — insbesondere keine Empfängeradressen und
 * keine Auskunft darüber, wer sonst auf der Liste steht.
 */
export type IncomingResult =
	| {
			kind: 'enqueued'
			message_id: number
			recipients: number
			/** true = dieselbe Mail wurde schon einmal angenommen (Worker-Retry). */
			duplicate: boolean
	  }
	| { kind: 'skipped'; reason: string }
	| { kind: 'unknown_list'; reason: string }
	| { kind: 'rejected'; reason: string }

/** HTTP-Status je Ergebnis — die Übersetzung, die der Worker erwartet. */
export const statusForResult = (result: IncomingResult): number => {
	switch (result.kind) {
		case 'enqueued':
			return 202
		case 'skipped':
			return 200
		case 'unknown_list':
			return 404
		case 'rejected':
			return 403
	}
}

const headerString = (
	headers: Map<string, unknown>,
	key: string,
): string | undefined => {
	const v = headers.get(key)
	if (typeof v === 'string') return v.toLowerCase()
	// strukturierter Header (z.B. Auto-Submitted) -> .value
	if (v && typeof v === 'object' && 'value' in v) {
		const val = (v as { value: unknown }).value
		if (typeof val === 'string') return val.toLowerCase()
	}
	return undefined
}

/**
 * Prüft, ob eine Adresse in eine Liste posten darf — ohne die Mail selbst.
 *
 * Der aktuelle Worker ruft das NICHT auf: Er reicht die Mail durch und liest
 * die Berechtigung am HTTP-Status von `/api/lists/incoming` ab. Der Endpunkt
 * bleibt trotzdem, weil er die Frage "warum kommt meine Mail nicht durch?"
 * beantwortet, ohne eine Mail verschicken zu müssen — und weil ein Worker, der
 * schon beim SMTP-Handshake ablehnen möchte, ihn brauchen würde.
 */
export type SenderCheck =
	| { allowed: true; list: string; label: string; recipients: number }
	| { allowed: false; reason: string; list?: string }

export const checkListSender = (
	listAddress: string,
	fromEmail: string,
	db?: Database,
): SenderCheck => {
	const list = getMailingList(listAddress, db)
	if (!list)
		return { allowed: false, reason: `Unbekannte Liste "${listAddress}".` }
	if (list.aktiv !== 1) {
		return {
			allowed: false,
			reason: `Die Liste "${listAddress}" ist derzeit deaktiviert.`,
			list: list.address,
		}
	}
	if (!isSenderAllowed(list, fromEmail, db)) {
		return {
			allowed: false,
			reason: `Diese Absenderadresse ist nicht berechtigt, an die Liste "${listAddress}" zu schreiben.`,
			list: list.address,
		}
	}
	return {
		allowed: true,
		list: list.address,
		label: list.label,
		recipients: resolveListRecipients(list, db).length,
	}
}

export type IncomingParams = {
	/** Listen-Localpart aus `X-List-Name`, z.B. `eltern`. */
	listName: string
	/**
	 * Envelope-Absender aus `X-List-Envelope-From` (SMTP `MAIL FROM`).
	 * **Hierauf wird autorisiert**, nicht auf den `From:`-Header im Body: der
	 * ist reiner Text und frei fälschbar, der Envelope-Absender läuft dagegen
	 * gegen SPF des einliefernden Servers.
	 */
	envelopeFrom: string
	/**
	 * `Message-ID:` der Originalmail aus `X-List-Message-Id`. Zusammen mit der
	 * Liste der Idempotenz-Schlüssel. Fehlt, wenn die Mail keine hat.
	 */
	messageId?: string | null
}

/**
 * Verarbeitet eine rohe RFC822-Mail, die der Cloudflare-Worker an eine Liste
 * durchgereicht hat:
 *  1. Liste muss existieren (sonst 404) und aktiv sein (sonst 403).
 *  2. Schleifen-/Auto-Reply-Schutz (List-Id vorhanden, Auto-Submitted,
 *     Precedence) — angenommen, aber nicht verteilt.
 *  3. Envelope-Absender muss posten dürfen (sonst 403).
 *  4. Empfänger auflösen (Gruppen effektiv, minus Opt-outs und gesperrte
 *     Adressen) und einreihen.
 *
 * Wirft nicht für "normale" Ablehnungen — die landen als Ergebnis-Variante.
 */
export const handleIncomingListMail = async (
	rawBody: Buffer,
	params: IncomingParams,
	db?: Database,
): Promise<IncomingResult> => {
	const { listName, envelopeFrom } = params

	const list = getMailingList(listName, db)
	if (!list) {
		return {
			kind: 'unknown_list',
			reason: `Es gibt keine Liste "${listName}".`,
		}
	}
	if (list.aktiv !== 1) {
		return {
			kind: 'rejected',
			reason: `Die Liste "${listName}" ist derzeit deaktiviert.`,
		}
	}

	if (!envelopeFrom.trim()) {
		return { kind: 'rejected', reason: 'Die Nachricht hat keinen Absender.' }
	}
	if (!isSenderAllowed(list, envelopeFrom, db)) {
		// Bewusst ohne Aufzählung, wer denn senden dürfte: Der Text geht als
		// Unzustellbarkeitsnachricht an den Absender.
		return {
			kind: 'rejected',
			reason: `Diese Absenderadresse ist nicht berechtigt, an die Liste "${listName}" zu schreiben.`,
		}
	}

	const parsed = await simpleParser(rawBody)

	// Schleifenschutz: eine bereits gelistete Mail oder eine automatische
	// Antwort (Abwesenheit, Bounce) darf nie erneut verteilt werden. mailparser
	// gruppiert die List-*-Header unter dem strukturierten Header `list`.
	const listHeader = parsed.headers.get('list') as { id?: unknown } | undefined
	if (listHeader?.id) {
		return {
			kind: 'skipped',
			reason: 'Ist bereits eine Listenmail (List-Id gesetzt).',
		}
	}
	const autoSubmitted = headerString(parsed.headers, 'auto-submitted')
	if (autoSubmitted && autoSubmitted !== 'no') {
		return {
			kind: 'skipped',
			reason: `Automatische Antwort: ${autoSubmitted}.`,
		}
	}
	const precedence = headerString(parsed.headers, 'precedence')
	if (precedence === 'list' || precedence === 'bulk' || precedence === 'junk') {
		return {
			kind: 'skipped',
			reason: `Massenmail (Precedence: ${precedence}).`,
		}
	}

	const recipients = resolveListRecipients(list, db).map((r) => ({
		email: r.email,
		mitglied_id: r.mitglied_id,
	}))
	if (recipients.length === 0) {
		return {
			kind: 'skipped',
			reason: 'Die Liste hat derzeit keine Empfänger.',
		}
	}

	// Anzeigename und Inhalt kommen aus dem Body; die Berechtigung nicht.
	const headerFrom = parsed.from?.value?.[0]
	const fromName = headerFrom?.name?.trim() || null
	const html = typeof parsed.html === 'string' ? parsed.html : null
	const text = typeof parsed.text === 'string' ? parsed.text : null
	// Der Worker schickt die Message-ID als Header mit; die geparste ist nur der
	// Rückfallwert, falls der Header fehlt.
	const messageId = params.messageId ?? parsed.messageId ?? null

	const { message_id, enqueued, duplicate } = enqueueListMessage(
		{
			list_address: list.address,
			from_email: normalizeEmail(envelopeFrom),
			from_name: fromName,
			subject: parsed.subject ?? '',
			body_html: html,
			body_text: text,
			original_message_id: messageId,
			// Message-ID plus Liste identifiziert die Zustellung eindeutig. Ohne
			// Message-ID gibt es keine Idempotenz — dann lieber verteilen als
			// schlucken.
			idempotency_key: messageId ? `${list.address}|${messageId}` : null,
			attachments: parsed.attachments.map((a) => ({
				filename: a.filename ?? null,
				content_type: a.contentType ?? null,
				content: a.content,
			})),
			recipients,
		},
		db,
	)

	return { kind: 'enqueued', message_id, recipients: enqueued, duplicate }
}
