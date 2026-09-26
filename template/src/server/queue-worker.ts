import { cleanupStuckListOutbound } from '../lib/db/listQueue.js'
import { cleanupStuckByTimeout, cleanupStuckOnBoot } from '../lib/db/sendLog.js'
import { processBatch } from '../lib/email/queue.js'
import { processListBatch } from '../lib/lists/queue.js'

const DEFAULT_POLL_MS = 30_000
const MAX_BATCHES_PER_TICK = 50
const STUCK_TIMEOUT_SECONDS = 30

let timer: NodeJS.Timeout | null = null
let running = false

const log = (msg: string): void => {
	console.log(`[queue-worker] ${msg}`)
}

const tick = async (): Promise<void> => {
	if (running) return
	running = true
	try {
		// SMTP-Stalls enden nicht mit einem Fehler; ohne Aufräumen blieben sending-Einträge für immer liegen.
		const stuck =
			cleanupStuckByTimeout(undefined, STUCK_TIMEOUT_SECONDS) +
			cleanupStuckListOutbound(undefined, STUCK_TIMEOUT_SECONDS)
		if (stuck > 0) {
			log(
				`Aufraeumen: ${stuck} haengende Eintraege (>${STUCK_TIMEOUT_SECONDS}s) auf error gesetzt`,
			)
		}
		await drainMailQueue()
		await drainListQueue()
	} catch (err) {
		log(
			`Tick fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
		)
	} finally {
		running = false
	}
}

const drainMailQueue = async (): Promise<void> => {
	for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
		const result = await processBatch()
		if (result.kind === 'queue_empty') return
		if (result.kind === 'cap_reached') {
			log(
				`Stunden-Cap erreicht (${result.sentInLastHour}/h) — Pause bis ${result.waitUntil}`,
			)
			return
		}
		let sent = 0
		let errors = 0
		for (const r of result.results) {
			if (r.status === 'fulfilled') {
				if (r.value.kind === 'sent') sent++
				else if (r.value.kind === 'error') {
					errors++
					log(`Fehler bei q#${r.value.queueId}: ${r.value.error}`)
				}
			} else {
				errors++
				log(
					`Batch-Task abgebrochen: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
				)
			}
		}
		log(
			`Rundmail-Batch: ${result.count} verarbeitet (${sent} gesendet, ${errors} Fehler)`,
		)
	}
}

const drainListQueue = async (): Promise<void> => {
	for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
		const result = await processListBatch()
		if (result.kind === 'queue_empty') return
		if (result.kind === 'cap_reached') {
			log(`Listen-Cap erreicht (${result.sentInLastHour}/h) — Pause`)
			return
		}
		let sent = 0
		let errors = 0
		for (const r of result.results) {
			if (r.status === 'fulfilled') {
				if (r.value.kind === 'sent') sent++
				else if (r.value.kind === 'error') {
					errors++
					log(`Fehler bei list#${r.value.outboundId}: ${r.value.error}`)
				}
			} else {
				errors++
				log(
					`Listen-Task abgebrochen: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
				)
			}
		}
		log(
			`Listen-Batch: ${result.count} verarbeitet (${sent} gesendet, ${errors} Fehler)`,
		)
	}
}

export const startQueueWorker = (
	intervalMs: number = DEFAULT_POLL_MS,
): void => {
	if (timer) return
	log(`Start (Poll alle ${Math.round(intervalMs / 1000)}s)`)
	// sending aus einer früheren Inkarnation (Deploy, Crash, OOM) schließt sonst niemand mehr ab.
	const cleaned = cleanupStuckOnBoot() + cleanupStuckListOutbound()
	if (cleaned > 0)
		log(`Boot-Aufraeumen: ${cleaned} verwaiste Eintraege auf error gesetzt`)
	void tick()
	timer = setInterval(() => {
		void tick()
	}, intervalMs)
}

export const stopQueueWorker = (): void => {
	if (timer) {
		clearInterval(timer)
		timer = null
	}
}
