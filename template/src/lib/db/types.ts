/**
 * Reine DB-Zeile der `mitglieder`-Tabelle (das Adressbuch: Eltern,
 * Lehrkraefte, Ansprechpartner). Zugehoerigkeiten stehen NICHT hier, sondern
 * als Group-Mitgliedschaften in `group_memberships` ("alles ist eine Group").
 *
 * DATENMINIMIERUNG: Hier steht bewusst nur, was der Versand braucht — Name
 * und E-Mail. Anrede, Telefonnummer und freie Notizen gab es einmal und sind
 * entfernt worden; was nicht gespeichert wird, kann auch nicht veralten oder
 * in die falschen Haende geraten.
 */
export type MitgliedRow = {
	id: string
	first_name: string
	last_name: string
	email: string | null
	created_at: string
	updated_at: string
}

/** Mitglied inklusive seiner Group-Keys (alphabetisch). */
export type MitgliedMitGroups = MitgliedRow & { groups: string[] }

/**
 * Eingabe fuer `upsertMitglied`. **Partielles Update:** Beim Aktualisieren
 * eines bestehenden Datensatzes werden nur die Felder veraendert, die
 * tatsaechlich mitgeschickt werden — ein weggelassenes Feld (`undefined`)
 * bleibt unveraendert, ein explizit als `null` uebergebenes Feld wird geleert
 * (JSON-Merge-Patch, RFC 7396).
 */
export type MitgliedInput = {
	id?: string
	first_name: string
	last_name: string
	email?: string | null
	/**
	 * Group-Keys (Whitelist `groups.key`), in denen die Person ist. Wird beim
	 * Upsert mit den `group_memberships`-Zeilen SYNCHRONISIERT: `undefined` =>
	 * Mitgliedschaften unveraendert lassen; `[]` => alle entfernen; `[...]` =>
	 * exakt diese Gruppen setzen. Nicht existierende Keys -> Fehler.
	 */
	groups?: string[]
}

/** Eine Gruppe/Verteiler (Whitelist-Eintrag), siehe Tabelle `groups`. */
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

/**
 * Empfaenger-Spec einer Rundmail. `group` = Group-Key (EFFEKTIV aufgeloest,
 * inkl. Untergruppen), `explicit` = gezielte ID-Liste, `union` = Vereinigung
 * mehrerer Specs (dedupliziert ueber die Mitglieds-ID).
 */
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
	/**
	 * Wann der Eintrag nach `sending` gewechselt ist (gesetzt via `claimQueued`).
	 * Basis fuer den Stuck-Cleanup, der SMTP-Stalls und Pod-Restarts erkennt.
	 */
	claimed_at: string | null
}

export type SendLogInsert = {
	email_slug: string
	mitglied_id: string
	status: SendStatus
	message_id?: string | null
	error_message?: string | null
}

/** Wie eine Liste auf Antworten reagiert: an den Absender oder an die Liste. */
export type ReplyMode = 'sender' | 'list'

/**
 * Wer an eine Liste schreiben darf:
 *   'offen'           jede Absenderadresse — auch von ausserhalb der Schule.
 *                     Vorgabe fuer NEUE Listen.
 *   'eingeschraenkt'  nur wer ueber `poster_groups` oder `sender_patterns`
 *                     erlaubt ist (`broadcast` gilt darin weiter).
 */
export type PosterPolicy = 'offen' | 'eingeschraenkt'

/**
 * Eine Mailingliste. `address` ist der localpart (z.B. `eltern` fuer
 * `eltern@<LIST_DOMAIN>`). Die vier Array-Spalten liegen als JSON-Strings in
 * der DB und werden von den Helfern in `mailingLists.ts` geparst.
 */
export type MailingListRow = {
	address: string
	label: string
	/** JSON-Array von Group-Keys der Empfaenger (roh aus der DB). */
	recipient_groups: string
	/** JSON-Array von Group-Keys der erlaubten Absender (roh aus der DB). */
	poster_groups: string
	/** Richtlinie fuer das Absenderrecht. */
	poster_policy: PosterPolicy
	/**
	 * JSON-Array erlaubter Absender-Muster (roh aus der DB): volle Adressen
	 * (`anna@example.org`) oder Domain-Platzhalter
	 * (`*@schule.example`). Wirkt nur bei
	 * `poster_policy = 'eingeschraenkt'`.
	 */
	sender_patterns: string
	/** JSON-Array zusaetzlicher Empfaenger-Adressen (roh aus der DB). */
	extra_recipients: string
	reply_mode: ReplyMode
	subject_prefix: string | null
	/**
	 * 1 = "Broadcasting": alle Empfaenger duerfen zusaetzlich posten (offene
	 * Diskussionsliste). 0 = nur poster_groups/sender_patterns (Ankuendigung).
	 * Ohne Bedeutung bei `poster_policy = 'offen'` — dort darf ohnehin jeder.
	 */
	broadcast: 0 | 1
	aktiv: 0 | 1
	created_at: string
	updated_at: string
}

export type MailingListInput = {
	address: string
	label: string
	/**
	 * Group-Keys der Empfaenger (Vereinigung). Mind. eine Gruppe ODER eine
	 * `extra_recipients`-Adresse muss gesetzt sein.
	 */
	recipient_groups: string[]
	/** Group-Keys der erlaubten Absender (Vereinigung). */
	poster_groups?: string[]
	/** Default beim Anlegen: 'offen'. */
	poster_policy?: PosterPolicy
	/**
	 * Erlaubte Absender: volle Adresse oder `*@domain`. Wirkt nur bei
	 * `poster_policy = 'eingeschraenkt'`.
	 */
	sender_patterns?: string[]
	/** Zusaetzliche Empfaenger-Einzeladressen. */
	extra_recipients?: string[]
	reply_mode?: ReplyMode
	subject_prefix?: string | null
	broadcast?: boolean
	aktiv?: boolean
}

/** Woher eine Sperre stammt. `complaint` wird nie automatisch aufgehoben. */
export type SuppressionSource = 'manual' | 'bounce' | 'complaint'

export type ListSuppressionRow = {
	mitglied_id: string
	/** Konkrete Listen-Adresse (localpart) oder `*` fuer globalen Opt-out. */
	list_address: string
	reason: string | null
	source: SuppressionSource
	created_at: string
}

export type AddressSuppressionRow = {
	/** Normalisierte (lowercase) E-Mail-Adresse. */
	email: string
	list_address: string
	reason: string | null
	source: SuppressionSource
	/** SES-Rohwert: `Permanent` | `Transient` | `Undetermined`. */
	bounce_type: string | null
	/** SES-Rohwert: `General` | `NoEmail` | `Suppressed` | ... */
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
