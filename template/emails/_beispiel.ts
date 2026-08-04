import type { Email } from '../src/lib/emails/types.js'

/**
 * Vorlage fuer eine Rundmail. Der Dateiname beginnt mit "_" und wird vom
 * Loader ignoriert. Zum Verschicken: Datei kopieren und mit Datumspraefix
 * benennen — der Dateiname OHNE `.ts` ist der Slug.
 *
 * Personalisierungs-Marker in allen Textfeldern:
 *   {{anrede}}      "Hallo Anna,"
 *   {{firstName}}   Vorname
 *   {{lastName}}    Nachname
 *
 * IDEMPOTENZ: Der Slug ist der Schluessel. Jede Person bekommt eine Mail mit
 * demselben Slug nur EINMAL. Eine Korrektur verschickt man unter einem NEUEN
 * Slug (Konvention: Suffix `-v2`) — nicht durch erneutes Senden desselben.
 *
 * Sicherheits-Flags:
 *   skip: { reason: "..." }                 harter Stopp, wird nie versendet
 *   sentExternally: { date: "YYYY-MM-DD" }  Archiv-Eintrag, wird nicht versendet
 *
 * ACHTUNG Datenschutz: In diese Dateien gehoeren nur Inhalte, niemals Namen
 * oder Adressen von Eltern. Die Empfaenger kommen ausschliesslich aus der
 * Datenbank (`recipients`).
 */
const email: Email = {
	subject: 'Einladung zum Elternabend',
	recipients: { kind: 'group', value: 'eltern' },
	template: {
		preheader: 'Termin und Tagesordnung',
		heading: 'Elternabend',
		blocks: [
			{ kind: 'paragraph', text: '{{anrede}}' },
			{
				kind: 'paragraph',
				text: 'hiermit laden wir herzlich zum naechsten Elternabend ein.',
			},
			{
				kind: 'event',
				title: 'Elternabend',
				date: 'BITTE EINTRAGEN',
				location: 'BITTE EINTRAGEN',
			},
			{ kind: 'divider' },
			{ kind: 'paragraph', text: 'Wir freuen uns auf euch.' },
		],
	},
}

export default email
