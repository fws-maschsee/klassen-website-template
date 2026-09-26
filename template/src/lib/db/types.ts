export type MitgliedRow = {
	id: string
	first_name: string
	last_name: string
	email: string | null
	created_at: string
	updated_at: string
}

export type MitgliedMitGroups = MitgliedRow & { groups: string[] }

export type MitgliedInput = {
	id?: string
	first_name: string
	last_name: string
	email?: string | null
	groups?: string[]
}

export type GroupRow = {
	key: string
	label: string
	aktiv: 0 | 1
	created_at: string
	updated_at: string
}

export type GroupInput = {
	key: string
	label: string
	aktiv?: boolean
}

export type EmailRecipientsKind = 'group' | 'explicit' | 'union'

export type EmailRow = {
	slug: string
	subject: string
	sender: string | null
	recipients_kind: EmailRecipientsKind
	last_synced_at: string
}

export type SendStatus = 'sent' | 'error' | 'skipped' | 'queued' | 'sending'

export type SendLogRow = {
	id: number
	email_slug: string
	mitglied_id: string
	sent_at: string
	status: SendStatus
	message_id: string | null
	error_message: string | null
	claimed_at: string | null
}

export type SendLogInsert = {
	email_slug: string
	mitglied_id: string
	status: SendStatus
	message_id?: string | null
	error_message?: string | null
}

export type ReplyMode = 'sender' | 'list'

export type PosterPolicy = 'offen' | 'eingeschraenkt'

export type MailingListRow = {
	address: string
	label: string
	recipient_groups: string
	poster_groups: string
	poster_policy: PosterPolicy
	sender_patterns: string
	extra_recipients: string
	reply_mode: ReplyMode
	subject_prefix: string | null
	broadcast: 0 | 1
	aktiv: 0 | 1
	created_at: string
	updated_at: string
}

export type MailingListInput = {
	address: string
	label: string
	recipient_groups: string[]
	poster_groups?: string[]
	poster_policy?: PosterPolicy
	sender_patterns?: string[]
	extra_recipients?: string[]
	reply_mode?: ReplyMode
	subject_prefix?: string | null
	broadcast?: boolean
	aktiv?: boolean
}

export type SuppressionSource = 'manual' | 'bounce' | 'complaint'

export type ListSuppressionRow = {
	mitglied_id: string
	list_address: string
	reason: string | null
	source: SuppressionSource
	created_at: string
}

export type AddressSuppressionRow = {
	email: string
	list_address: string
	reason: string | null
	source: SuppressionSource
	bounce_type: string | null
	bounce_subtype: string | null
	event_count: number
	last_event_at: string
	created_at: string
}

export type ListMessageRow = {
	id: number
	list_address: string
	from_email: string
	from_name: string | null
	subject: string
	body_html: string | null
	body_text: string | null
	original_message_id: string | null
	idempotency_key: string | null
	received_at: string
}

export type ListAttachmentRow = {
	id: number
	message_id: number
	filename: string | null
	content_type: string | null
	content: Buffer
}

export type ListOutboundRow = {
	id: number
	message_id: number
	recipient_email: string
	mitglied_id: string | null
	status: 'queued' | 'sending' | 'sent' | 'error'
	sent_message_id: string | null
	error_message: string | null
	claimed_at: string | null
	created_at: string
	sent_at: string | null
}
