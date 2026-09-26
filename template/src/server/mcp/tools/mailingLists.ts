import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
	deleteMailingList,
	getMailingList,
	listMailingLists,
	resolveAllowedSenders,
	resolveListRecipients,
	upsertMailingList,
} from '../../../lib/db/mailingLists.js'
import {
	GLOBAL_SUPPRESSION,
	listAddressSuppressions,
	listSuppressionsForAddress,
	listSuppressionsForMitglied,
	suppressAddress,
	suppressListRecipient,
	unsuppressAddress,
	unsuppressListRecipient,
} from '../../../lib/db/suppressions.js'
import { listDomain } from '../../../lib/email/config.js'
import type { McpAuth } from '../guard.js'
import {
	registerPersonalDataTool,
	registerReadTool,
	registerWriteTool,
} from '../guard.js'

const toJson = (value: unknown): string => JSON.stringify(value, null, 2)

const AddressSchema = z
	.string()
	.regex(
		/^[a-z0-9]+([._-][a-z0-9]+)*$/,
		"Nur der localpart vor dem @, z.B. 'eltern'.",
	)

const GroupKeySchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)

const SourceSchema = z.enum(['manual', 'bounce', 'complaint'])

const errorResult = (err: unknown) => ({
	isError: true as const,
	content: [{ type: 'text' as const, text: (err as Error).message }],
})

export const registerMailingListTools = (
	server: McpServer,
	auth: McpAuth,
): void => {
	registerReadTool(
		server,
		auth,
		'list_mailing_lists',
		{
			title: 'Mailinglisten auflisten',
			description:
				'Listet alle Mailinglisten. Jede Liste hat eine Adresse (localpart vor dem @), recipient_groups (wer bekommt sie), poster_policy (offen = jeder darf schreiben, eingeschraenkt = nur poster_groups/sender_patterns) und reply_mode. Eingehende Mail an <address>@<LIST_DOMAIN> wird an die Empfaenger weiterverteilt, wenn der Absender berechtigt ist.',
			inputSchema: {},
		},
		() => ({
			content: [
				{
					type: 'text',
					text: toJson({
						list_domain: listDomain(),
						lists: listMailingLists(),
					}),
				},
			],
		}),
	)

	registerReadTool(
		server,
		auth,
		'get_mailing_list',
		{
			title: 'Mailingliste anzeigen (inkl. aufgeloester Zahlen)',
			description:
				'Zeigt eine Liste plus die aktuell aufgeloeste Anzahl erlaubter Absender und Empfaenger (nach Opt-outs und Adress-Sperren). Gut, um vor dem Scharfschalten zu pruefen, wer schreiben darf und wer empfaengt. ACHTUNG bei allowed_senders: bei poster_policy "offen" darf JEDE Adresse schreiben, und Domain-Platzhalter aus sender_patterns lassen sich nicht aufzaehlen — die Zahl zaehlt nur die namentlich bekannten Adressen.',
			inputSchema: { address: AddressSchema },
		},
		({ address }) => {
			const list = getMailingList(address)
			if (!list) {
				return errorResult(
					new Error(
						`Unbekannte Liste "${address}". list_mailing_lists zeigt vorhandene.`,
					),
				)
			}
			return {
				content: [
					{
						type: 'text',
						text: toJson({
							...list,
							full_address: `${list.address}@${listDomain()}`,
							allowed_senders: resolveAllowedSenders(list).size,
							recipients: resolveListRecipients(list).length,
						}),
					},
				],
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'upsert_mailing_list',
		{
			title: 'Mailingliste anlegen oder aendern',
			description:
				"Legt eine Liste an oder aktualisiert sie. recipient_groups und poster_groups muessen existierende Gruppen sein (list_groups); mehrere Gruppen werden jeweils vereinigt, dedupliziert und EFFEKTIV (inkl. Untergruppen) aufgeloest. Ueber extra_recipients lassen sich einzelne Adressen als Empfaenger eintragen, auch ohne Adressbuch-Eintrag. Mindestens eine recipient_groups-Gruppe ODER eine extra_recipients-Adresse ist noetig. poster_policy entscheidet ueber das Absenderrecht: 'offen' (Default fuer neue Listen) laesst JEDE Adresse schreiben, 'eingeschraenkt' nur poster_groups und sender_patterns. reply_mode: 'sender' = Antworten gehen an den Originalabsender (Ankuendigung, Default), 'list' = an die Liste (Diskussion). broadcast: true macht aus der Ankuendigungs- eine offene Diskussionsliste — dann duerfen alle Empfaenger zusaetzlich posten (nur bei 'eingeschraenkt' von Bedeutung).",
			inputSchema: {
				address: AddressSchema,
				label: z.string().min(1),
				recipient_groups: z
					.array(GroupKeySchema)
					.describe("Group-Keys der Empfaenger, z.B. ['eltern']."),
				poster_groups: z
					.array(GroupKeySchema)
					.optional()
					.describe(
						'Group-Keys der erlaubten Absender. Leer/weggelassen = keine Poster-Gruppe, dann zaehlen nur sender_patterns.',
					),
				poster_policy: z
					.enum(['offen', 'eingeschraenkt'])
					.optional()
					.describe(
						"'offen' (Default beim Anlegen) = jede Absenderadresse darf schreiben, auch von ausserhalb der Schule. 'eingeschraenkt' = nur poster_groups und sender_patterns.",
					),
				sender_patterns: z
					.array(z.string().min(3))
					.optional()
					.describe(
						"Erlaubte Absender bei poster_policy 'eingeschraenkt': volle Adresse ('anna@example.org') oder Domain-Platzhalter ('*@schule.example'). Der Stern steht nur ganz vorne; die Domain wird exakt verglichen, '*@example.org' trifft NICHT 'anna@mail.example.org'.",
					),
				extra_recipients: z
					.array(z.string().email())
					.optional()
					.describe(
						'Zusaetzliche Empfaenger-Einzeladressen ohne Adressbuch-Eintrag (z.B. Schulbuero).',
					),
				reply_mode: z.enum(['sender', 'list']).optional(),
				subject_prefix: z
					.string()
					.nullable()
					.optional()
					.describe("Optionaler Betreff-Prefix, z.B. '[Eltern]'."),
				broadcast: z
					.boolean()
					.optional()
					.describe(
						'Offene Diskussionsliste: wenn true, duerfen ALLE Empfaenger auch posten. Default false = nur die Absender-Whitelist (Ankuendigungsliste). Sinnvoll zusammen mit reply_mode "list".',
					),
				aktiv: z.boolean().optional(),
			},
		},
		(args) => {
			try {
				return {
					content: [{ type: 'text', text: toJson(upsertMailingList(args)) }],
				}
			} catch (err) {
				return errorResult(err)
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'delete_mailing_list',
		{
			title: 'Mailingliste loeschen',
			description:
				'Loescht eine Mailingliste. ACHTUNG: Danach nimmt die App Mail an diese Adresse nicht mehr an — der Cloudflare-Worker bekommt eine Ablehnung zurueck und weist die Mail beim Absender ab.',
			inputSchema: { address: AddressSchema },
		},
		({ address }) => {
			const deleted = deleteMailingList(address)
			return {
				content: [
					{
						type: 'text',
						text: deleted
							? `Liste ${address} geloescht.`
							: `Liste ${address} existierte nicht.`,
					},
				],
			}
		},
	)

	registerPersonalDataTool(
		server,
		auth,
		'list_list_recipients',
		{
			title: 'Empfaenger einer Liste anzeigen',
			description:
				'Zeigt die konkret aufgeloesten Empfaenger einer Liste: Personen der recipient_groups (effektiv) MIT E-Mail, abzueglich personengebundener Opt-outs und gesperrter Adressen, plus die extra_recipients. Das ist genau die Menge, die bei einer Aussendung angeschrieben wuerde.',
			inputSchema: { address: AddressSchema },
		},
		({ address }) => {
			const list = getMailingList(address)
			if (!list) {
				return errorResult(
					new Error(
						`Unbekannte Liste "${address}". list_mailing_lists zeigt vorhandene.`,
					),
				)
			}
			const recipients = resolveListRecipients(list)
			return {
				content: [
					{
						type: 'text',
						text: toJson({ count: recipients.length, recipients }),
					},
				],
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'suppress_list_recipient',
		{
			title: 'Von Liste abmelden (Opt-out / Sperre)',
			description:
				"Traegt eine Sperre ein (idempotent). Entweder mitglied_id (Person bleibt in der Gruppe, bekommt aber keine Mail dieser Liste mehr) ODER email (sperrt die ADRESSE — auch wenn dazu kein Adressbuch-Eintrag existiert; das ist der Weg fuer Bounces und Beschwerden). address='*' sperrt global fuer ALLE Listen; genau das ist bei einem harten Bounce richtig. source: 'manual' (Default bei mitglied_id), 'bounce' oder 'complaint'.",
			inputSchema: {
				mitglied_id: z
					.string()
					.optional()
					.describe('ID aus dem Adressbuch. Entweder dies oder email angeben.'),
				email: z
					.string()
					.email()
					.optional()
					.describe(
						'E-Mail-Adresse. Entweder dies oder mitglied_id angeben. Fuer Bounces/Beschwerden.',
					),
				address: z
					.union([AddressSchema, z.literal(GLOBAL_SUPPRESSION)])
					.describe("Listen-localpart oder '*' fuer alle Listen."),
				reason: z.string().optional(),
				source: SourceSchema.optional(),
				bounce_type: z
					.string()
					.optional()
					.describe("SES-Rohwert: 'Permanent' | 'Transient' | 'Undetermined'."),
				bounce_subtype: z
					.string()
					.optional()
					.describe("SES-Rohwert: 'General' | 'NoEmail' | 'Suppressed' | ..."),
			},
		},
		({
			mitglied_id,
			email,
			address,
			reason,
			source,
			bounce_type,
			bounce_subtype,
		}) => {
			try {
				if (mitglied_id && email) {
					return errorResult(
						new Error(
							'Bitte entweder mitglied_id ODER email angeben, nicht beides.',
						),
					)
				}
				if (mitglied_id) {
					const rows = suppressListRecipient(
						mitglied_id,
						address,
						reason ?? null,
						source ?? 'manual',
					)
					return {
						content: [
							{
								type: 'text',
								text: toJson({ mitglied_id, suppressions: rows }),
							},
						],
					}
				}
				if (email) {
					const row = suppressAddress({
						email,
						list_address: address,
						reason: reason ?? null,
						source: source ?? 'bounce',
						bounce_type: bounce_type ?? null,
						bounce_subtype: bounce_subtype ?? null,
					})
					return { content: [{ type: 'text', text: toJson(row) }] }
				}
				return errorResult(new Error('Bitte mitglied_id ODER email angeben.'))
			} catch (err) {
				return errorResult(err)
			}
		},
	)

	registerWriteTool(
		server,
		auth,
		'unsuppress_list_recipient',
		{
			title: 'Sperre aufheben',
			description:
				"Entfernt eine Sperre wieder — entweder personengebunden (mitglied_id) oder adressgebunden (email). address='*' hebt die globale Sperre auf. Bei source='complaint' (Spam-Beschwerde) sollte das NICHT ohne ausdrueckliche Rueckmeldung der betroffenen Person passieren.",
			inputSchema: {
				mitglied_id: z.string().optional(),
				email: z.string().email().optional(),
				address: z.union([AddressSchema, z.literal(GLOBAL_SUPPRESSION)]),
			},
		},
		({ mitglied_id, email, address }) => {
			if (mitglied_id) {
				const rows = unsuppressListRecipient(mitglied_id, address)
				return {
					content: [
						{ type: 'text', text: toJson({ mitglied_id, suppressions: rows }) },
					],
				}
			}
			if (email) {
				const removed = unsuppressAddress(email, address)
				return {
					content: [
						{ type: 'text', text: toJson({ email, address, removed }) },
					],
				}
			}
			return errorResult(new Error('Bitte mitglied_id ODER email angeben.'))
		},
	)

	registerPersonalDataTool(
		server,
		auth,
		'list_list_suppressions',
		{
			title: 'Sperren und Opt-outs anzeigen',
			description:
				'Zeigt beide Ebenen der Sperren: personengebundene Opt-outs (list_suppressions) und adressgebundene Sperren (address_suppressions, u.a. Bounces und Beschwerden inkl. bounce_type und Zaehler). Ohne Argument kommen alle Adress-Sperren; mit address die Sperren einer Liste; mit mitglied_id die Opt-outs einer Person.',
			inputSchema: {
				address: z
					.union([AddressSchema, z.literal(GLOBAL_SUPPRESSION)])
					.optional(),
				mitglied_id: z.string().optional(),
			},
		},
		({ address, mitglied_id }) => {
			if (mitglied_id) {
				return {
					content: [
						{
							type: 'text',
							text: toJson({
								mitglied_id,
								personen_optouts: listSuppressionsForMitglied(mitglied_id),
							}),
						},
					],
				}
			}
			if (address) {
				return {
					content: [
						{
							type: 'text',
							text: toJson({
								address,
								personen_optouts: listSuppressionsForAddress(address),
								adress_sperren: listAddressSuppressions(address),
							}),
						},
					],
				}
			}
			return {
				content: [
					{
						type: 'text',
						text: toJson({ adress_sperren: listAddressSuppressions() }),
					},
				],
			}
		},
	)
}
