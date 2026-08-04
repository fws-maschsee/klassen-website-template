import type { Email } from '../../../src/lib/emails/types.js'

/** Mail mit hartem Stopp — darf nie eingereiht werden. */
const email: Email = {
	subject: 'Nicht senden',
	recipients: { kind: 'group', value: 'eltern' },
	skip: { reason: 'Nur ein Entwurf' },
	template: { heading: 'Entwurf', blocks: [] },
}

export default email
