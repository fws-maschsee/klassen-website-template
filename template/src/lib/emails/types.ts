export type Block =
	| { kind: 'paragraph'; text: string }
	| { kind: 'heading'; text: string }
	| { kind: 'button'; text: string; href: string }
	| { kind: 'divider' }
	| {
			kind: 'event'
			title: string
			date: string
			location: string
			href?: string
			cta?: string
	  }

export type EmailTemplate = {
	preheader?: string
	heading: string
	blocks: Block[]
	signature?: { name: string; role: string }
	ps?: string
}

export type Recipients =
	| { kind: 'group'; value: string }
	| { kind: 'explicit'; ids: string[] }
	| { kind: 'union'; of: Recipients[] }

export type Email = {
	subject: string
	recipients: Recipients
	replyTo?: string
	from?: string
	template: EmailTemplate
	sentExternally?: {
		date: string
		note?: string
	}
	skip?: {
		reason: string
	}
}

export type LoadedEmail = {
	slug: string
	email: Email
}
