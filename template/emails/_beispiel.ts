import type { Email } from '../src/lib/emails/types.js'

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
