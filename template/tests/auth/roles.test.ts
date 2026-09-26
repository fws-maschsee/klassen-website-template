import { describe, expect, it } from 'vitest'
import {
	canEdit,
	canRead,
	canSeePersonalData,
	may,
	ROLE_ADMIN,
	ROLE_MITGLIED,
} from '../../src/server/auth/roles.js'

describe('Rollen', () => {
	it('laesst ohne Rolle niemanden herein', () => {
		expect(canRead([])).toBe(false)
		expect(canSeePersonalData([])).toBe(false)
		expect(canEdit([])).toBe(false)
	})

	it('gibt mitglied das Lesen der Verteiler, aber keine Personendaten', () => {
		expect(canRead([ROLE_MITGLIED])).toBe(true)
		expect(canSeePersonalData([ROLE_MITGLIED])).toBe(false)
		expect(canEdit([ROLE_MITGLIED])).toBe(false)
	})

	it('gibt admin alles', () => {
		expect(canRead([ROLE_ADMIN])).toBe(true)
		expect(canSeePersonalData([ROLE_ADMIN])).toBe(true)
		expect(canEdit([ROLE_ADMIN])).toBe(true)
	})

	it('laesst admin auch ohne zusaetzlichen mitglied-Grant lesen', () => {
		expect(canRead([ROLE_ADMIN])).toBe(true)
	})

	it('kennt die konfigurierbare Leserolle', () => {
		expect(canRead(['eltern'], 'eltern')).toBe(true)
		expect(canRead([ROLE_MITGLIED], 'eltern')).toBe(false)
		expect(canRead([ROLE_ADMIN], 'eltern')).toBe(true)
	})

	it('ignoriert fremde und falsch geschriebene Rollennamen', () => {
		expect(canRead(['vorstand', 'kollegium'])).toBe(false)
		expect(canEdit(['Admin', 'ADMIN'])).toBe(false)
	})

	it('bildet die drei Faehigkeiten konsistent ab', () => {
		for (const roles of [[], [ROLE_MITGLIED], [ROLE_ADMIN]]) {
			expect(may(roles, 'lesen')).toBe(canRead(roles))
			expect(may(roles, 'personen')).toBe(canSeePersonalData(roles))
			expect(may(roles, 'bearbeiten')).toBe(canEdit(roles))
		}
	})
})
