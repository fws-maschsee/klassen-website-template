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

/**
 * Empfaenger einer Rundmail ("alles ist eine Group"):
 *   - eine Gruppe        -> { kind: "group", value: "eltern" }
 *   - gezielte Auswahl   -> { kind: "explicit", ids: [...] }
 *   - mehrere Verteiler  -> { kind: "union", of: [...] }
 *
 * `group` wird EFFEKTIV aufgeloest, also inklusive aller Untergruppen.
 * `union` dedupliziert ueber die Mitglieds-ID, damit niemand die Mail doppelt
 * bekommt.
 */
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
	/** Archiv-Eintrag: wurde ausserhalb dieses Systems verschickt. */
	sentExternally?: {
		date: string
		note?: string
	}
	/** Harter Stopp: wird unabhaengig vom Send-Log NIE verschickt. */
	skip?: {
		reason: string
	}
}

export type LoadedEmail = {
	slug: string
	email: Email
}
