import type { MitgliedRow } from '../db/types.js'

export const personalizedAnrede = (mitglied: MitgliedRow): string =>
	`Hallo ${mitglied.first_name},`
