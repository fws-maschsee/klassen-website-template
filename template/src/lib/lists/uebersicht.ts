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

/**
 * Was ein Mitglied ueber die Verteiler der Klasse sehen darf — zur LAUFZEIT
 * aus der Datenbank, nicht aus einer Markdown-Datei.
 *
 * WARUM ES DIESE DATEI GIBT: Die Adressen standen einmal von Hand im Text.
 * Damit lag dieselbe Angabe an zwei Orten, und der zweite ist veraltet — in
 * einer der Referenzklassen stand monatelang die abgeloeste Mailman-Adresse
 * auf der Seite, waehrend die Anwendung laengst unter
 * `eltern@<klasse>.<listen-domain>` zustellte. Wer darauf geantwortet hat, hat
 * ins Leere geschrieben. Eine reine Textkorrektur haette denselben Fehler nur
 * vertagt; deshalb kommt die Uebersicht jetzt aus derselben Quelle, aus der
 * auch zugestellt wird.
 *
 * WAS HIER NICHT HINEINGEHOERT: Wer im Einzelnen auf einer Liste steht. Das
 * ist personenbezogen und geht die uebrigen Familien nichts an (siehe
 * `Capability` in src/server/auth/roles.ts). Diese Ansicht nennt deshalb
 * GRUPPEN, keine Personen — und auch keine Anzahl, denn aus "3 Personen" laesst
 * sich in einer Klasse schnell erraten, wer gemeint ist.
 */

/** Wer an eine Liste schreiben darf, in der Form, die die Seite anzeigt. */
export type SchreibrechtAnsicht =
	| { kind: 'offen' }
	| {
			kind: 'eingeschraenkt'
			/** Labels der Gruppen, die schreiben duerfen. */
			gruppen: string[]
			/** Angezeigte Absender-Muster (`*@domain.tld`). */
			muster: string[]
			/**
			 * Einzelne freigeschaltete Adressen. Nur fuer Betrachter mit der
			 * Faehigkeit `personen` gefuellt — eine Adresse ist personenbezogen,
			 * ein Domain-Muster nicht.
			 */
			adressen: string[]
			/**
			 * Wie viele Einzeladressen ausgeblendet wurden. Damit steht auf der
			 * Seite "und 2 weitere Adressen" statt einer stillen Luecke: dass es
			 * mehr gibt, darf jeder wissen, nur nicht welche.
			 */
			verborgeneAdressen: number
			/** Zusaetzlich duerfen alle Empfaenger schreiben (`broadcast`). */
			auchEmpfaenger: boolean
	  }

/** Ein Verteiler, so wie ihn die Seite zeigt. */
export type VerteilerAnsicht = {
	/**
	 * Vollstaendige Adresse, zusammengesetzt aus dem Localpart der Liste und
	 * der Listen-Domain dieser Klasse (`listDomain()`). Nirgends fest
	 * verdrahtet — genau darum geht es.
	 */
	adresse: string
	label: string
	/** Labels der erreichten Gruppen (keine Personen, keine Anzahl). */
	empfaengerGruppen: string[]
	/**
	 * Labels der Gruppen, die ueber eine Untergruppe mit erreicht werden.
	 * Sichtbar zu machen, WEN eine Obergruppe stillschweigend einschliesst, ist
	 * der halbe Zweck der Seite.
	 */
	weitereUeberUntergruppen: string[]
	schreibrecht: SchreibrechtAnsicht
	antwortAn: ReplyMode
	betreffPraefix: string | null
}

/** Label der Gruppe, oder ersatzweise ihr Key, falls sie geloescht wurde. */
const groupLabel = (key: string, db: Database): string =>
	getGroup(key, db)?.label ?? key

/** `*@domain.tld` — unbedenklich, weil es keine Person benennt. */
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
		verborgeneAdressen: darfPersonenSehen ? 0 : adressen.length,
		auchEmpfaenger: list.broadcast === 1,
	}
}

/**
 * Die Verteiler der Klasse fuer die oeffentliche Uebersicht.
 *
 * `darfPersonenSehen` entscheidet ausschliesslich ueber Einzeladressen in den
 * Absender-Mustern; alles andere sieht jedes Mitglied. Inaktive Listen
 * erscheinen nicht — sie nehmen keine Post an, und eine Adresse anzuzeigen,
 * die abprallt, ist schlimmer als sie wegzulassen.
 */
export const verteilerUebersicht = (
	darfPersonenSehen: boolean,
	db: Database = openDb(),
): VerteilerAnsicht[] => {
	const domain = listDomain()
	return listMailingLists(db)
		.filter((list) => list.aktiv === 1)
		.map((list) => {
			const direkt = listRecipientGroups(list)
			const alle = expandToSubtrees(direkt, db)
			const nurUeberUntergruppen = alle.filter((key) => !direkt.includes(key))
			return {
				adresse: `${list.address}@${domain}`,
				label: list.label,
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
