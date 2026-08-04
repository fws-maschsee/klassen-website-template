import type { Email } from '../../../src/lib/emails/types.js'

/** Beginnt mit "_" und muss deshalb vom Loader ignoriert werden. */
const email: Email = {
	subject: 'Vorlage',
	recipients: { kind: 'group', value: 'eltern' },
	template: { heading: 'Vorlage', blocks: [] },
}

export default email
