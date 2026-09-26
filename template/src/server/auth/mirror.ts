import type { Database } from 'better-sqlite3'
import { upsertGroup } from '../../lib/db/groups.js'
import { openDb } from '../../lib/db/index.js'
import { slugify, uniqueMemberId } from '../../lib/db/members.js'
import { clearGrantsCache, type GrantedUser, usersWithRole } from './grants.js'
import { ROLE_MITGLIED } from './roles.js'

export const MIRROR_ID_PREFIX = 'zitadel-'

export const memberGroupKey = (): string =>
	process.env.LIST_MEMBER_GROUP?.trim() || 'eltern'

export const memberRole = (): string =>
	process.env.OIDC_REQUIRED_ROLE?.trim() || ROLE_MITGLIED

export type MirrorResult = {
	added: number
	updated: number
	removed: number
	rekeyed: number
	rekeyed_with_suffix: number
	total: number
}

type MirroredRow = {
	id: string
	first_name: string
	last_name: string
	email: string | null
	zitadel_user_id: string
}

const splitName = (user: GrantedUser): { first: string; last: string } => {
	if (user.firstName || user.lastName) {
		return { first: user.firstName, last: user.lastName }
	}
	const local = user.email.split('@')[0]
	return { first: local, last: '' }
}

export const syncMembersFromZitadel = async (
	db: Database = openDb(),
): Promise<MirrorResult> => {
	clearGrantsCache()
	const granted = await usersWithRole(memberRole())
	const groupKey = memberGroupKey()

	upsertGroup({ key: groupKey, label: 'Eltern', aktiv: true }, db)

	const existing = db
		.prepare<[], MirroredRow>(
			`SELECT id, first_name, last_name, email, zitadel_user_id
         FROM mitglieder
        WHERE zitadel_user_id IS NOT NULL`,
		)
		.all()
	const byUserId = new Map(existing.map((row) => [row.zitadel_user_id, row]))

	let added = 0
	let updated = 0
	let rekeyed = 0
	let rekeyedWithSuffix = 0
	const seen = new Set<string>()

	const insert = db.prepare(
		`INSERT INTO mitglieder (id, first_name, last_name, email, zitadel_user_id)
     VALUES (@id, @first_name, @last_name, @email, @zitadel_user_id)`,
	)
	const update = db.prepare(
		'UPDATE mitglieder SET first_name = @first_name, last_name = @last_name, email = @email WHERE id = @id',
	)
	const link = db.prepare<[string, string]>(
		'INSERT OR IGNORE INTO group_memberships (group_key, mitglied_id) VALUES (?, ?)',
	)
	const drop = db.prepare<[string]>('DELETE FROM mitglieder WHERE id = ?')

	const rekeyLegacyRow = (row: MirroredRow, first: string, last: string) => {
		const neu = uniqueMemberId(first, last, db, row.id)
		if (neu === row.id) return row.id
		insert.run({
			id: neu,
			first_name: first,
			last_name: last,
			email: row.email,
			zitadel_user_id: null,
		})
		for (const sql of [
			'UPDATE group_memberships SET mitglied_id = ? WHERE mitglied_id = ?',
			'UPDATE email_send_log SET mitglied_id = ? WHERE mitglied_id = ?',
			'UPDATE list_suppressions SET mitglied_id = ? WHERE mitglied_id = ?',
			'UPDATE list_outbound SET mitglied_id = ? WHERE mitglied_id = ?',
		]) {
			db.prepare<[string, string]>(sql).run(neu, row.id)
		}
		drop.run(row.id)
		db.prepare<[string, string]>(
			'UPDATE mitglieder SET zitadel_user_id = ? WHERE id = ?',
		).run(row.zitadel_user_id, neu)
		rekeyed++
		if (neu !== slugify(first, last)) rekeyedWithSuffix++
		return neu
	}

	const tx = db.transaction(() => {
		for (const user of granted) {
			seen.add(user.userId)
			const { first, last } = splitName(user)
			const current = byUserId.get(user.userId)
			if (!current) {
				const neu = uniqueMemberId(first, last, db)
				insert.run({
					id: neu,
					first_name: first,
					last_name: last,
					email: user.email,
					zitadel_user_id: user.userId,
				})
				added++
				link.run(groupKey, neu)
				continue
			}
			let id = current.id
			if (id.startsWith(MIRROR_ID_PREFIX)) {
				id = rekeyLegacyRow(current, first, last)
			}
			if (
				current.first_name !== first ||
				current.last_name !== last ||
				(current.email ?? '') !== user.email
			) {
				update.run({
					id,
					first_name: first,
					last_name: last,
					email: user.email,
				})
				updated++
			}
			link.run(groupKey, id)
		}

		for (const [userId, row] of byUserId) {
			if (!seen.has(userId)) drop.run(row.id)
		}
	})
	tx()

	const removed = [...byUserId.keys()].filter((id) => !seen.has(id)).length
	return {
		added,
		updated,
		removed,
		rekeyed,
		rekeyed_with_suffix: rekeyedWithSuffix,
		total: granted.length,
	}
}
