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
	sender?: string
	envelope?: { from: string; to: string }
	headers?: Record<string, string>
}

export type SendOutput = { messageId: string }

export type EmailTransport = {
	send(input: SendInput): Promise<SendOutput>
}

export const SES_DEFAULT_HOST = 'email-smtp.eu-central-1.amazonaws.com'
// 2587 statt 587: 25, 465 und 587 waren providerseitig blockiert.
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

export const resetTransportCache = (): void => {
	cached = null
}
