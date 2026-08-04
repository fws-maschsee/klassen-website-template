import type { Email } from '../../../src/lib/emails/types.js'

/** Test-Fixture. Erfundene Inhalte, keine echten Daten. */
const email: Email = {
	subject: 'Testmail fuer {{firstName}}',
	recipients: { kind: 'group', value: 'eltern' },
	template: {
		heading: 'Hallo {{firstName}}',
		blocks: [
			{ kind: 'paragraph', text: '{{anrede}}' },
			{ kind: 'paragraph', text: 'Das ist eine Testnachricht.' },
		],
	},
}

export default email
