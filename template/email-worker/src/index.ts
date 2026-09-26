import { parseListRecipient } from './address.js'
import { deliver, smtpSafe, TemporaryFailure } from './app.js'
import { type Env, readConfig } from './env.js'

export interface IncomingMessage {
	readonly from: string
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
	const config = readConfig(env)

	const parsed = parseListRecipient(
		message.to,
		config.listDomain,
		config.classSlug,
	)
	if (!parsed.ok) {
		console.error(`Adresse abgewiesen (${message.to}): ${parsed.reason}`)
		message.setReject(smtpSafe(`Unbekannte Listenadresse: ${parsed.reason}`))
		return
	}
	const recipient = parsed.value

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

	const verdict = await deliver(config, recipient, message.from, messageId, raw)
	if (verdict.kind === 'rejected') {
		message.setReject(verdict.reason)
	}
}

export default {
	async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
		try {
			await handleEmail(message, env)
		} catch (error) {
			const reason =
				error instanceof TemporaryFailure ? 'temporär' : 'unerwartet'
			console.error(`Zustellung an die App fehlgeschlagen (${reason}):`, error)
			throw error
		}
	},
} satisfies ExportedHandler<Env>
