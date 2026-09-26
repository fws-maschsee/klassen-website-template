import type { Email } from '../../../src/lib/emails/types.js'

const email: Email = {
	subject: 'Vorlage',
	recipients: { kind: 'group', value: 'eltern' },
	template: { heading: 'Vorlage', blocks: [] },
}

export default email
