import type { Block, EmailTemplate } from '../emails/types.js'
import { className, mailReplyTo, siteUrl } from './config.js'

// Zurueckhaltende, warme Palette. Bewusst kein Corporate-Design-Klotz: Das
// hier sind Elternmails einer Schulklasse, keine Werbung.
const ACCENT = '#3f6f52'
const ACCENT_LIGHT = '#eef4f0'
const INK = '#1f2933'
const MUTED = '#5b6b7a'

const renderBlock = (block: Block): string => {
	switch (block.kind) {
		case 'paragraph':
			return `
      <mj-text font-family="Helvetica, Arial, sans-serif" color="${INK}" font-size="16px" line-height="1.6" padding="8px 0">
        ${block.text}
      </mj-text>`

		case 'heading':
			return `
      <mj-text font-family="Helvetica, Arial, sans-serif" color="${ACCENT}" font-size="20px" font-weight="700" line-height="1.3" padding="16px 0 8px">
        ${block.text}
      </mj-text>`

		case 'button':
			return `
      <mj-button background-color="${ACCENT}" color="#ffffff" font-family="Helvetica, Arial, sans-serif" font-size="16px" font-weight="600" border-radius="6px" padding="16px 0" inner-padding="12px 28px" href="${block.href}">
        ${block.text}
      </mj-button>`

		case 'divider':
			return `
      <mj-divider border-color="#e2e8f0" border-width="1px" padding="16px 0" />`

		case 'event': {
			const ctaHtml = block.href
				? `<tr><td style="padding-top:14px;"><a href="${block.href}" style="font-family:Helvetica,Arial,sans-serif;color:${ACCENT};font-size:15px;font-weight:700;text-decoration:none;">${block.cta ?? 'Mehr dazu'} &rarr;</a></td></tr>`
				: ''
			return `
      <mj-text padding="20px 0">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;border-radius:4px;overflow:hidden;">
          <tr>
            <td width="4" bgcolor="${ACCENT}" style="width:4px;min-width:4px;max-width:4px;line-height:0;font-size:0;">&nbsp;</td>
            <td bgcolor="${ACCENT_LIGHT}" style="padding:20px 24px;background-color:${ACCENT_LIGHT};">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
                <tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:0.12em;color:${ACCENT};font-weight:700;padding-bottom:6px;">Termin</td></tr>
                <tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:19px;font-weight:700;color:${INK};line-height:1.3;padding-bottom:12px;">${block.title}</td></tr>
                <tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:${INK};line-height:1.5;padding-bottom:4px;"><span style="display:inline-block;min-width:56px;color:${ACCENT};font-weight:700;">Wann:</span>${block.date}</td></tr>
                <tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:${INK};line-height:1.5;"><span style="display:inline-block;min-width:56px;color:${ACCENT};font-weight:700;">Wo:</span>${block.location}</td></tr>
                ${ctaHtml}
              </table>
            </td>
          </tr>
        </table>
      </mj-text>`
		}
	}
}

/**
 * Baut das MJML-Dokument einer Rundmail. Kopf- und Fusszeile kommen aus
 * `config.ts` (Klassenname, Antwortadresse, Website), damit die zweite
 * Klassen-Instanz nichts umschreiben muss.
 */
export const template = (props: EmailTemplate): string => {
	const { preheader, heading, blocks, signature, ps } = props
	const klasse = className()
	const replyTo = mailReplyTo()
	const web = siteUrl()

	const preheaderHtml = preheader
		? `<div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader}</div>`
		: ''

	const signatureHtml = signature
		? `
      <mj-text font-family="Helvetica, Arial, sans-serif" color="${INK}" font-size="15px" padding="16px 0 0">
        Viele Gruesse,<br/>
        <strong>${signature.name}</strong><br/>
        ${signature.role}
      </mj-text>`
		: ''

	const psHtml = ps
		? `
      <mj-text font-family="Helvetica, Arial, sans-serif" color="${INK}" font-size="14px" line-height="1.6" padding="16px 0 0">
        <em>P.S.: ${ps}</em>
      </mj-text>`
		: ''

	const blocksHtml = blocks.map(renderBlock).join('\n')

	return `
<mjml>
  <mj-head>
    <mj-title>${klasse}</mj-title>
    <mj-attributes>
      <mj-all font-family="Helvetica, Arial, sans-serif" />
    </mj-attributes>
    <mj-style inline="inline">
      table { border-collapse: collapse; }
      td { word-break: break-word; }
      img { max-width: 100%; height: auto; display: block; }
      a { word-break: break-word; }
    </mj-style>
    <mj-raw>
      ${preheaderHtml}
    </mj-raw>
  </mj-head>
  <mj-body background-color="#f4f5f7" width="600px">

    <mj-section background-color="${ACCENT}" padding="20px 0">
      <mj-column>
        <mj-text color="#ffffff" font-size="20px" font-weight="700" align="center" letter-spacing="0.02em">
          ${klasse}
        </mj-text>
      </mj-column>
    </mj-section>

    <mj-section background-color="#ffffff" padding="32px 0 24px">
      <mj-column padding="0 32px">
        <mj-text color="${INK}" font-size="26px" font-weight="700" line-height="1.2" padding="0 0 16px">
          ${heading}
        </mj-text>
        ${blocksHtml}
        ${signatureHtml}
        ${psHtml}
      </mj-column>
    </mj-section>

    <mj-section background-color="#ffffff" padding="0 0 24px">
      <mj-column padding="0 32px">
        <mj-text color="${MUTED}" font-size="12px" align="center" line-height="1.6">
          Diese Nachricht ging an die Elternschaft der ${klasse}.<br/>
          Antworten bitte an <a href="mailto:${replyTo}" style="color:${ACCENT};text-decoration:none;">${replyTo}</a>
          &nbsp;·&nbsp;
          <a href="${web}" style="color:${ACCENT};text-decoration:none;">${web}</a>
        </mj-text>
      </mj-column>
    </mj-section>

  </mj-body>
</mjml>
`.trim()
}
