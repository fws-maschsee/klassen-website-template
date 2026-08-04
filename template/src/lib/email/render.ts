import type { MitgliedRow } from '../db/types.js'
import type { Block, Email, EmailTemplate } from '../emails/types.js'
import { personalizedAnrede } from './anrede.js'
import { compile } from './compile.js'
import { template } from './template.js'

/**
 * Personalisierungs-Marker, die in jedem Textfeld einer Rundmail ersetzt
 * werden:
 *   {{anrede}}      "Hallo <Vorname>,"
 *   {{firstName}}   Vorname
 *   {{lastName}}    Nachname
 *
 * Frueher gab es zusaetzlich `{{anredeDu}}` und `{{salutation}}` sowie den
 * Schalter `duzen` an der Mail. Beides hing an der Spalte `salutation` im
 * Adressbuch, die entfallen ist — es gibt jetzt nur noch eine Ansprache.
 */
const personalizeString = (text: string, mitglied: MitgliedRow): string =>
	text
		.replaceAll('{{anrede}}', personalizedAnrede(mitglied))
		.replaceAll('{{firstName}}', mitglied.first_name)
		.replaceAll('{{lastName}}', mitglied.last_name)

const personalizeBlock = (block: Block, mitglied: MitgliedRow): Block => {
	const p = (text: string): string => personalizeString(text, mitglied)
	switch (block.kind) {
		case 'paragraph':
			return { kind: 'paragraph', text: p(block.text) }
		case 'heading':
			return { kind: 'heading', text: p(block.text) }
		case 'button':
			return { kind: 'button', text: p(block.text), href: p(block.href) }
		case 'divider':
			return block
		case 'event':
			return {
				kind: 'event',
				title: p(block.title),
				date: p(block.date),
				location: p(block.location),
				href: block.href ? p(block.href) : undefined,
				cta: block.cta ? p(block.cta) : undefined,
			}
	}
}

export const personalizeTemplate = (
	tpl: EmailTemplate,
	mitglied: MitgliedRow,
): EmailTemplate => ({
	preheader: tpl.preheader
		? personalizeString(tpl.preheader, mitglied)
		: undefined,
	heading: personalizeString(tpl.heading, mitglied),
	blocks: tpl.blocks.map((b) => personalizeBlock(b, mitglied)),
	signature: tpl.signature,
	ps: tpl.ps ? personalizeString(tpl.ps, mitglied) : undefined,
})

export type RenderedEmail = {
	subject: string
	html: string
	text: string
}

export const renderForRecipient = async (
	email: Email,
	mitglied: MitgliedRow,
): Promise<RenderedEmail> => {
	const subject = personalizeString(email.subject, mitglied)
	const tpl = personalizeTemplate(email.template, mitglied)
	const { html, text } = await compile(template(tpl))
	return { subject, html, text }
}
