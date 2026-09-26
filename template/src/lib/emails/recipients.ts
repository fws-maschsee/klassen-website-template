import type { Database } from 'better-sqlite3'
import {
	getMitgliederByIds,
	listMitgliederByGroupEffective,
} from '../db/members.js'
import type { MitgliedRow } from '../db/types.js'
import type { Recipients } from './types.js'

export const resolveRecipients = (
	recipients: Recipients,
	db?: Database,
): MitgliedRow[] => {
	switch (recipients.kind) {
		case 'group':
			return listMitgliederByGroupEffective(recipients.value, db)
		case 'explicit':
			return getMitgliederByIds(recipients.ids, db)
		case 'union': {
			const seen = new Set<string>()
			const out: MitgliedRow[] = []
			for (const sub of recipients.of) {
				for (const m of resolveRecipients(sub, db)) {
					if (!seen.has(m.id)) {
						seen.add(m.id)
						out.push(m)
					}
				}
			}
			return out
		}
	}
}

export const isEmailRecipient = (m: MitgliedRow): boolean => !!m.email

export const isUnreachable = (m: MitgliedRow): boolean => !m.email
