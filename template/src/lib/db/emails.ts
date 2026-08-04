import type { Database } from 'better-sqlite3'
import { openDb } from './index.js'
import type { EmailRecipientsKind, EmailRow } from './types.js'

export type EmailMetaInput = {
	slug: string
	subject: string
	sender: string | null
	recipients_kind: EmailRecipientsKind
}

export const listEmails = (db: Database = openDb()): EmailRow[] =>
	db.prepare<[], EmailRow>('SELECT * FROM emails ORDER BY slug DESC').all()

export const getEmail = (
	slug: string,
	db: Database = openDb(),
): EmailRow | undefined =>
	db
		.prepare<[string], EmailRow>('SELECT * FROM emails WHERE slug = ?')
		.get(slug)

export const upsertEmailMeta = (
	input: EmailMetaInput,
	db: Database = openDb(),
): void => {
	db.prepare<EmailMetaInput>(
		`INSERT INTO emails (slug, subject, sender, recipients_kind)
       VALUES (@slug, @subject, @sender, @recipients_kind)
       ON CONFLICT(slug) DO UPDATE SET
         subject = excluded.subject,
         sender = excluded.sender,
         recipients_kind = excluded.recipients_kind,
         last_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
	).run(input)
}

export const deleteEmail = (slug: string, db: Database = openDb()): boolean =>
	db.prepare<[string]>('DELETE FROM emails WHERE slug = ?').run(slug).changes >
	0
