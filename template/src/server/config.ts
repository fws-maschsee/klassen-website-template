import { SITE_URL } from '../site.config.js'

export const publicBaseUrl = (): string =>
	(process.env.PUBLIC_BASE_URL ?? SITE_URL).replace(/\/+$/, '')

export const port = (): number =>
	Number.parseInt(process.env.PORT ?? '4321', 10)
