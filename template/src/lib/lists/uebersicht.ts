import type { Database } from 'better-sqlite3'
import { expandToSubtrees, getGroup } from '../db/groups.js'
import { openDb } from '../db/index.js'
import {
	listMailingLists,
	listPosterGroups,
	listPosterPolicy,
	listRecipientGroups,
	listSenderPatterns,
} from '../db/mailingLists.js'
import type { MailingListRow, ReplyMode } from '../db/types.js'
import { listDomain } from '../email/config.js'

export type SchreibrechtAnsicht =
	| { kind: 'offen' }
	| {
			kind: 'eingeschraenkt'
			gruppen: string[]
			muster: string[]
			adressen: string[]
			verborgeneAdressen: number
			auchEmpfaenger: boolean
	  }

export type VerteilerAnsicht = {
	adresse: string
	label: string
	empfaengerGruppen: string[]
	weitereUeberUntergruppen: string[]
	schreibrecht: SchreibrechtAnsicht
	antwortAn: ReplyMode
	betreffPraefix: string | null
}

const groupLabel = (key: string, db: Database): string =>
	getGroup(key, db)?.label ?? key

const istDomainMuster = (muster: string): boolean => muster.startsWith('*@')

const schreibrecht = (
	list: MailingListRow,
	darfPersonenSehen: boolean,
	db: Database,
): SchreibrechtAnsicht => {
	if (listPosterPolicy(list) === 'offen') return { kind: 'offen' }
	const muster = listSenderPatterns(list)
	const adressen = muster.filter((m) => !istDomainMuster(m))
	return {
		kind: 'eingeschraenkt',
		gruppen: listPosterGroups(list).map((key) => groupLabel(key, db)),
		muster: muster.filter(istDomainMuster),
		adressen: darfPersonenSehen ? adressen : [],
		// Anzahl statt stiller Lücke: dass es weitere gibt, darf jeder wissen, nur nicht welche.
		verborgeneAdressen: darfPersonenSehen ? 0 : adressen.length,
		auchEmpfaenger: list.broadcast === 1,
	}
}

// Zur Laufzeit aus der DB statt von Hand im Text: eine abgeschriebene Adresse veraltet, Antworten gingen ins Leere.
export const verteilerUebersicht = (
	darfPersonenSehen: boolean,
	db: Database = openDb(),
): VerteilerAnsicht[] => {
	const domain = listDomain()
	// Inaktive Listen nehmen keine Post an; eine abprallende Adresse anzuzeigen ist schlimmer als sie wegzulassen.
	return listMailingLists(db)
		.filter((list) => list.aktiv === 1)
		.map((list) => {
			const direkt = listRecipientGroups(list)
			const alle = expandToSubtrees(direkt, db)
			const nurUeberUntergruppen = alle.filter((key) => !direkt.includes(key))
			return {
				adresse: `${list.address}@${domain}`,
				label: list.label,
				// Gruppen, keine Personen und keine Anzahl: in einer Klasse ließe sich sonst erraten, wer gemeint ist.
				empfaengerGruppen: direkt.map((key) => groupLabel(key, db)),
				weitereUeberUntergruppen: nurUeberUntergruppen.map((key) =>
					groupLabel(key, db),
				),
				schreibrecht: schreibrecht(list, darfPersonenSehen, db),
				antwortAn: list.reply_mode,
				betreffPraefix: list.subject_prefix,
			}
		})
}
