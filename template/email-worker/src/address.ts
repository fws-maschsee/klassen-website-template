export type ParsedRecipient = {
	list: string
	class: string
	recipient: string
	tag: string | null
}

export type ParseResult =
	| { ok: true; value: ParsedRecipient }
	| { ok: false; reason: string }

// Bewusst streng: Klasse und Liste landen in HTTP-Headern und in der Ablehnung an den Absender.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const isSlug = (value: string): boolean => SLUG.test(value)

const TAG = /^[a-z0-9._-]+$/

const MAX_LABEL_LENGTH = 63 // DNS-Label-Grenze

const MAX_LOCALPART_LENGTH = 64 // RFC 5321

export const parseListRecipient = (
	rcptTo: string,
	listDomain: string,
	expectedClass: string,
): ParseResult => {
	const address = rcptTo.trim().toLowerCase()
	const suffix = `.${listDomain
		.trim()
		.toLowerCase()
		.replace(/^\.|\.$/g, '')}`

	const at = address.lastIndexOf('@')
	if (at <= 0 || at === address.length - 1) {
		return { ok: false, reason: 'keine gültige E-Mail-Adresse' }
	}

	const localpart = address.slice(0, at)
	const domain = address.slice(at + 1)

	if (!domain.endsWith(suffix)) {
		return { ok: false, reason: `Domain gehört nicht zu ${suffix.slice(1)}` }
	}

	const classSlug = domain.slice(0, -suffix.length)
	if (!isSlug(classSlug) || classSlug.length > MAX_LABEL_LENGTH) {
		return { ok: false, reason: 'kein gültiges Klassen-Label in der Domain' }
	}

	if (classSlug !== expectedClass) {
		return {
			ok: false,
			reason: `Adresse gehört zu ${classSlug}, dieser Verteiler bedient ${expectedClass}`,
		}
	}

	if (localpart.length > MAX_LOCALPART_LENGTH) {
		return { ok: false, reason: 'Localpart zu lang' }
	}
	// Sonst ginge `eltern+@x@klasse-….` als Liste `eltern` durch.
	if (localpart.includes('@')) {
		return { ok: false, reason: 'mehrere @ in der Adresse' }
	}

	const plus = localpart.indexOf('+')
	const list = plus === -1 ? localpart : localpart.slice(0, plus)
	const tag = plus === -1 ? null : localpart.slice(plus + 1) || null

	if (!isSlug(list)) {
		return { ok: false, reason: 'kein gültiger Listenname' }
	}
	if (tag !== null && !TAG.test(tag)) {
		return { ok: false, reason: 'kein gültiges Suffix nach dem Plus' }
	}

	return {
		ok: true,
		value: { list, class: classSlug, recipient: address, tag },
	}
}
