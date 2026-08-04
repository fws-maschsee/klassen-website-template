/**
 * Cloudflare Email Worker für die Mailinglisten dieser Klasse.
 *
 * Nimmt Mail an `<liste>@<klasse>.<LIST_DOMAIN>` entgegen und reicht sie an
 * die App dieser Klasse weiter. Welche Klasse das ist, steht in `CLASS_SLUG`
 * (siehe `wrangler.toml`). Der Worker liegt bewusst im
 * Repository der Klasse: Website, Worker und App-Anbindung bleiben ein Stück,
 * eine neue Klasse generiert ihr Repo aus der Vorlage und hat alles beisammen,
 * und ein kaputter Worker trifft eine Klasse statt alle.
 *
 * Fachlogik enthält er keine: Welche Listen es gibt und wer an sie senden darf,
 * weiß allein die App. Sie antwortet mit 403/404, und erst dann weist der Worker
 * die Mail ab.
 *
 * Ablauf:
 *   1. Adresse zerlegen und gegen `CLASS_SLUG` prüfen. Passt sie nicht ins
 *      Schema oder gehört sie zu einer anderen Klasse -> dauerhaft ablehnen.
 *   2. Größe prüfen (`rawSize`, noch bevor der Body gelesen wird) -> ggf. ablehnen.
 *   3. Rohe Mail an die App posten.
 *   4. 403/404/413 -> dauerhaft ablehnen, mit der Begründung der App.
 *   5. Alles andere Unerwartete -> Exception -> temporärer SMTP-Fehler, der
 *      absendende Server stellt später erneut zu.
 *
 * Die Mail verschwindet dadurch nie stillschweigend: Entweder die App hat sie,
 * oder der Absender bekommt eine Fehlermeldung — dauerhaft, wenn er selbst
 * etwas ändern muss, temporär, wenn es an uns liegt.
 */
import { parseListRecipient } from './address.js'
import { deliver, smtpSafe, TemporaryFailure } from './app.js'
import { type Env, readConfig } from './env.js'

/**
 * Der Ausschnitt von `ForwardableEmailMessage`, den dieser Worker benutzt.
 * Strukturell kompatibel, aber ohne Workers-Runtime konstruierbar — damit die
 * Tests eine Mail einfach als Objektliteral bauen können.
 */
export interface IncomingMessage {
	/** Envelope-Absender (SMTP `MAIL FROM`). */
	readonly from: string
	/** Envelope-Empfänger (SMTP `RCPT TO`). */
	readonly to: string
	readonly headers: Headers
	readonly raw: ReadableStream<Uint8Array>
	readonly rawSize: number
	setReject(reason: string): void
}

const megabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

export const handleEmail = async (
	message: IncomingMessage,
	env: Env,
): Promise<void> => {
	// Wirft bei fehlender oder unbrauchbarer Konfiguration -> temporärer Fehler.
	// Absichtlich: eine vergessene Variable darf keine Elternpost dauerhaft
	// zurückweisen.
	const config = readConfig(env)

	const parsed = parseListRecipient(
		message.to,
		config.listDomain,
		config.classSlug,
	)
	if (!parsed.ok) {
		// Ein Treffer auf eine fremde Klasse heißt: Die Cloudflare-Regel zeigt auf
		// den falschen Worker. Ins Log, damit das auffällt — die Mail wird
		// abgewiesen und keinesfalls an die eigene App weitergereicht.
		console.error(`Adresse abgewiesen (${message.to}): ${parsed.reason}`)
		message.setReject(smtpSafe(`Unbekannte Listenadresse: ${parsed.reason}`))
		return
	}
	const recipient = parsed.value

	// `rawSize` steht vor dem Lesen des Streams zur Verfügung. Cloudflare weist
	// über 25 MiB schon selbst ab; hier greift unser deutlich kleineres Limit,
	// damit die App keine Mail bekommt, die sie ohnehin nicht verteilen könnte.
	if (message.rawSize > config.maxMessageBytes) {
		message.setReject(
			smtpSafe(
				`Nachricht zu groß (${megabytes(message.rawSize)} MB, erlaubt sind ${megabytes(config.maxMessageBytes)} MB). Bitte große Anhänge verlinken statt anhängen.`,
			),
		)
		return
	}

	const messageId = message.headers.get('message-id')
	const raw = new Uint8Array(await new Response(message.raw).arrayBuffer())

	const verdict = await deliver(
		config,
		recipient,
		// Maßgeblich für die Berechtigung ist der Envelope-Absender. Er wird vom
		// absendenden Mailserver gesetzt und läuft gegen SPF; der `From:`-Header
		// im Body ist dagegen frei wählbar.
		message.from,
		messageId,
		raw,
	)
	if (verdict.kind === 'rejected') {
		message.setReject(verdict.reason)
	}
	// 2xx: die App hat übernommen (verteilt oder bewusst ignoriert, z.B.
	// Abwesenheitsnotiz oder Schleife). Für den Worker ist beides „erledigt".
}

export default {
	async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
		try {
			await handleEmail(message, env)
		} catch (error) {
			// Protokollieren und weiterwerfen: Cloudflare beendet die SMTP-Sitzung
			// dann mit einem temporären Fehler, der absendende Server versucht es
			// über Stunden bis Tage erneut. Alternativen wären schlechter —
			// stillschweigend annehmen verliert die Mail, dauerhaft ablehnen gibt
			// dem Absender die Schuld an unserem Ausfall.
			const reason =
				error instanceof TemporaryFailure ? 'temporär' : 'unerwartet'
			console.error(`Zustellung an die App fehlgeschlagen (${reason}):`, error)
			throw error
		}
	},
} satisfies ExportedHandler<Env>
