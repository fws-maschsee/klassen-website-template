import type { APIRoute } from 'astro'
import { checkListSender } from '../../../lib/lists/incoming.js'
import {
	HEADER_SIGNATURE,
	HEADER_TIMESTAMP,
	verifyListSignature,
} from '../../../lib/lists/signature.js'

export const prerender = false

type CheckBody = {
	list?: unknown
	from?: unknown
}

export const POST: APIRoute = async ({ request }) => {
	const rawBody = Buffer.from(await request.arrayBuffer())

	const sig = verifyListSignature({
		secret: process.env.LIST_WEBHOOK_SECRET,
		timestamp: request.headers.get(HEADER_TIMESTAMP),
		signature: request.headers.get(HEADER_SIGNATURE),
		rawBody,
	})
	if (!sig.ok) {
		return Response.json({ error: sig.reason }, { status: 401 })
	}

	let body: CheckBody
	try {
		body = JSON.parse(rawBody.toString('utf-8')) as CheckBody
	} catch {
		return Response.json({ error: 'ungueltiges JSON' }, { status: 400 })
	}

	const list = typeof body.list === 'string' ? body.list : null
	const from = typeof body.from === 'string' ? body.from : null
	if (!list || !from) {
		return Response.json(
			{ error: 'Felder "list" und "from" sind Pflicht' },
			{ status: 400 },
		)
	}

	const result = checkListSender(list, from)
	return Response.json(result, { status: result.allowed ? 200 : 403 })
}
