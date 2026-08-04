import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { upsertEmailMeta } from '../../../lib/db/emails.js'
import {
	countByStatus,
	listSendLog,
	requeueErrors,
} from '../../../lib/db/sendLog.js'
import { enqueueEmailToRecipients } from '../../../lib/email/queue.js'
import { renderForRecipient } from '../../../lib/email/render.js'
import {
	listEmailSlugs,
	loadAllEmails,
	loadEmail,
} from '../../../lib/emails/loader.js'
import {
	isUnreachable,
	resolveRecipients,
} from '../../../lib/emails/recipients.js'
import type { McpAuth } from '../guard.js'
import {
	registerPersonalDataTool,
	registerReadTool,
	registerWriteTool,
} from '../guard.js'

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

/**
 * Legt die Metadaten der Mail in der DB an. Noetig, weil `email_send_log` per
 * FK auf `emails.slug` zeigt — ohne diese Zeile schlaegt das Einreihen fehl.
 */
const syncEmailMeta = async (slug: string): Promise<void> => {
	const email = await loadEmail(slug)
	upsertEmailMeta({
		slug,
		subject: email.subject,
		sender: email.from ?? null,
		recipients_kind: email.recipients.kind,
	})
}

const errorResult = (err: unknown) => ({
	isError: true as const,
	content: [
		{
			type: 'text' as const,
			text: err instanceof Error ? err.message : String(err),
		},
	],
})

export const registerEmailTools = (server: McpServer, auth: McpAuth): void => {
	registerReadTool(
		server,
		auth,
		'list_emails',
		{
			title: 'Rundmails im Repo auflisten',
			description:
				'Listet alle Rundmails im `emails/`-Verzeichnis mit Betreff, Empfaenger-Art, Stopp-Flags und Versand-Statistik (sent/error/skipped/queued) aus der Datenbank.',
			inputSchema: {},
		},
		async () => {
			const emails = await loadAllEmails()
			const result = emails.map(({ slug, email }) => ({
				slug,
				subject: email.subject,
				recipients_kind: email.recipients.kind,
				skip: email.skip,
				sentExternally: email.sentExternally,
				counts: countByStatus(slug),
			}))
			return { content: [{ type: 'text', text: toJson(result) }] }
		},
	)

	registerReadTool(
		server,
		auth,
		'list_email_slugs',
		{
			title: 'Nur die Slugs auflisten',
			description: 'Schmalere Variante von list_emails — nur die Slug-Liste.',
			inputSchema: {},
		},
		() => ({ content: [{ type: 'text', text: toJson(listEmailSlugs()) }] }),
	)

	registerPersonalDataTool(
		server,
		auth,
		'get_email',
		{
			title: 'Rundmail-Details abfragen',
			description:
				'Liefert das vollstaendige Email-Objekt (Template, Empfaenger-Spec, Flags) fuer einen Slug plus die aufgeloeste Empfaengerzahl.',
			inputSchema: { slug: z.string() },
		},
		async ({ slug }) => {
			try {
				const email = await loadEmail(slug)
				const recipients = resolveRecipients(email.recipients)
				return {
					content: [
						{
							type: 'text',
							text: toJson({
								slug,
								email,
								recipients_total: recipients.length,
								recipients_ohne_email: recipients
									.filter(isUnreachable)
									.map((m) => ({
										id: m.id,
										name: `${m.first_name} ${m.last_name}`,
									})),
							}),
						},
					],
				}
			} catch (err) {
				return errorResult(err)
			}
		},
	)

	registerPersonalDataTool(
		server,
		auth,
		'preview_email',
		{
			title: 'Vorschau einer Rundmail rendern',
			description:
				'Rendert die Mail fuer eine konkrete Person (oder die erste aus der Empfaengerliste). Gibt Betreff, Plaintext und HTML zurueck — so laesst sich die Personalisierung pruefen, BEVOR verschickt wird.',
			inputSchema: {
				slug: z.string(),
				mitglied_id: z
					.string()
					.optional()
					.describe(
						'Ohne Angabe wird die erste Person aus der aufgeloesten Empfaengerliste genommen.',
					),
			},
		},
		async ({ slug, mitglied_id }) => {
			try {
				const email = await loadEmail(slug)
				const recipients = resolveRecipients(email.recipients)
				const mitglied = mitglied_id
					? recipients.find((r) => r.id === mitglied_id)
					: recipients[0]
				if (!mitglied) {
					return errorResult(
						new Error(
							mitglied_id
								? `${mitglied_id} ist nicht in der Empfaengerliste von ${slug}.`
								: `Die Empfaengerliste von ${slug} ist leer.`,
						),
					)
				}
				const rendered = await renderForRecipient(email, mitglied)
				return {
					content: [
						{
							type: 'text',
							text: toJson({
								slug,
								previewed_for: {
									id: mitglied.id,
									name: `${mitglied.first_name} ${mitglied.last_name}`,
								},
								subject: rendered.subject,
								text: rendered.text,
								html_length: rendered.html.length,
								html: rendered.html,
							}),
						},
					],
				}
			} catch (err) {
				return errorResult(err)
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'send_email',
		{
			title: 'Rundmail in die Versand-Queue stellen',
			description:
				'Reiht die Mail fuer alle aufgeloesten Empfaenger ein; der Worker verschickt sie ueber SES unter Beachtung des Stunden-Caps. IDEMPOTENT: Wer diese Mail bereits erhalten hat (sent-Eintrag) oder schon in der Queue steht, wird uebersprungen. Ein Korrekturversand gehoert unter einen NEUEN Slug (Konvention: Suffix -v2), nicht unter denselben. force=true umgeht die Pruefung und kann Doppelversand ausloesen — nur nach ausdruecklicher Ansage benutzen.',
			inputSchema: {
				slug: z.string(),
				force: z
					.boolean()
					.optional()
					.describe(
						'Erneut an bereits belieferte Empfaenger schicken. Loest Doppelversand aus.',
					),
			},
		},
		async ({ slug, force }) => {
			try {
				await syncEmailMeta(slug)
				const result = await enqueueEmailToRecipients(slug, {
					force: force ?? false,
				})
				return { content: [{ type: 'text', text: toJson(result) }] }
			} catch (err) {
				return errorResult(err)
			}
		},
	)

	registerPersonalDataTool(
		server,
		auth,
		'get_send_log',
		{
			title: 'Versand-Log einer Rundmail',
			description:
				'Listet alle Versand-Versuche (sent/error/skipped/queued/sending) einer Mail plus die Zaehlung nach dem jeweils LETZTEN Status pro Person.',
			inputSchema: { slug: z.string() },
		},
		({ slug }) => ({
			content: [
				{
					type: 'text',
					text: toJson({
						slug,
						counts: countByStatus(slug),
						log: listSendLog(slug),
					}),
				},
			],
		}),
	)

	registerWriteTool(
		server,
		auth,
		'retry_failed_sends',
		{
			title: 'Fehlgeschlagene Versendungen erneut einreihen',
			description:
				'Reiht genau die Empfaenger erneut ein, deren LETZTER Versuch fehlgeschlagen ist. Alte Fehler-Eintraege bleiben als Historie stehen. Erfolgreich Belieferte werden nicht angefasst — es entsteht also kein Doppelversand.',
			inputSchema: { slug: z.string() },
		},
		({ slug }) => ({
			content: [
				{
					type: 'text',
					text: toJson({ slug, requeued: requeueErrors(slug) }),
				},
			],
		}),
	)
}
