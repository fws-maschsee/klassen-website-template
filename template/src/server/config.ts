import { SITE_URL } from '../site.config.js'

/**
 * Oeffentliche Basis-URL dieser Instanz. Der OAuth-Issuer und die
 * Discovery-Metadaten muessen exakt der Adresse entsprechen, unter der die
 * Instanz erreichbar ist — sonst lehnt der MCP-Client die Tokens ab.
 */
export const publicBaseUrl = (): string =>
	(process.env.PUBLIC_BASE_URL ?? SITE_URL).replace(/\/+$/, '')

export const port = (): number =>
	Number.parseInt(process.env.PORT ?? '4321', 10)
