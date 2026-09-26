export const ROLE_MITGLIED = 'mitglied'

export const ROLE_ADMIN = 'admin'

export type Capability = 'lesen' | 'personen' | 'bearbeiten'

export const may = (
	roles: readonly string[],
	capability: Capability,
	requiredRole: string = ROLE_MITGLIED,
): boolean => {
	const admin = roles.includes(ROLE_ADMIN)
	if (capability === 'lesen') return admin || roles.includes(requiredRole)
	return admin
}

export const canRead = (
	roles: readonly string[],
	requiredRole: string = ROLE_MITGLIED,
): boolean => may(roles, 'lesen', requiredRole)

export const canSeePersonalData = (roles: readonly string[]): boolean =>
	may(roles, 'personen')

export const canEdit = (roles: readonly string[]): boolean =>
	may(roles, 'bearbeiten')

export const deniedMessage = (capability: Capability): string => {
	const was =
		capability === 'personen'
			? 'Namen und Adressen der Familien zu sehen'
			: 'zu bearbeiten oder zu senden'
	return (
		`Dieser Zugang darf die Verteiler sehen, aber nicht ${was}. ` +
		`Dafuer braucht es die Rolle "${ROLE_ADMIN}" im ZITADEL-Projekt dieser Klasse. ` +
		'Die Klassenelternvertretung kann sie vergeben.'
	)
}

export const EDIT_DENIED_MESSAGE = deniedMessage('bearbeiten')
