import type { Transporter } from 'nodemailer'
import nodemailer from 'nodemailer'

export type SendAttachment = {
	filename: string
	content: Buffer
	contentType?: string
}

export type SendInput = {
	from: string
	to: string
	replyTo: string
	subject: string
	html: string
	text: string
	attachments?: SendAttachment[]
	/** Optionaler `Sender:`-Header. */
	sender?: string
	/**
	 * Expliziter SMTP-Envelope (MAIL FROM / RCPT TO). Ohne dies nimmt nodemailer
	 * `from` als Return-Path — fuer Listen brauchen wir aber die verifizierte
	 * Versandadresse, sonst scheitert SES an SPF/DKIM-Alignment.
	 */
	envelope?: { from: string; to: string }
	/** Zusaetzliche Roh-Header (z.B. List-Id, List-Unsubscribe). */
	headers?: Record<string, string>
}

export type SendOutput = { messageId: string }

export type EmailTransport = {
	send(input: SendInput): Promise<SendOutput>
}

/**
 * Versand laeuft ueber das SMTP-Interface von **Amazon SES** in der Region
 * eu-central-1.
 *
 * PORT 2587 IST ABSICHT. Nicht auf 587 "vereinheitlichen": 25, 465 und 587
 * waren zwischenzeitlich providerseitig blockiert; 2587 ist der von SES
 * zusaetzlich angebotene STARTTLS-Port und funktioniert unabhaengig von diesen
 * Sperren. Wer den Port aendert, muss vorher nachweisen, dass 587 aus dem Pod
 * heraus wirklich erreichbar ist.
 *
 * Zugangsdaten sind SES-SMTP-Credentials (NICHT die IAM-Access-Keys — SES
 * leitet die SMTP-Credentials aus einem IAM-User ab, sie sehen anders aus).
 */
export const SES_DEFAULT_HOST = 'email-smtp.eu-central-1.amazonaws.com'
export const SES_DEFAULT_PORT = 2587

const requireEnv = (key: string): string => {
	const v = process.env[key]
	if (!v) throw new Error(`Fehlende Umgebungsvariable: ${key}`)
	return v
}

let cached: Transporter | null = null

const buildSesTransport = (): Transporter => {
	if (cached) return cached
	const port = Number.parseInt(
		process.env.SES_SMTP_PORT ?? `${SES_DEFAULT_PORT}`,
		10,
	)
	cached = nodemailer.createTransport({
		host: process.env.SES_SMTP_HOST ?? SES_DEFAULT_HOST,
		port,
		// 465 waere implizites TLS (SMTPS); 2587 und 587 sind STARTTLS-Ports.
		secure: port === 465,
		requireTLS: port !== 465,
		auth: {
			user: requireEnv('SES_SMTP_USER'),
			pass: requireEnv('SES_SMTP_PASSWORD'),
		},
	})
	return cached
}

export const sesTransport = (): EmailTransport => ({
	send: async (input) => {
		const info = await buildSesTransport().sendMail(input)
		return { messageId: info.messageId }
	},
})

/** Nur fuer Tests: erzwingt beim naechsten Aufruf einen frischen Transporter. */
export const resetTransportCache = (): void => {
	cached = null
}
