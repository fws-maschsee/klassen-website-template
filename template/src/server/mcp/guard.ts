import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
	McpServer,
	RegisteredTool,
	ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
	AnySchema,
	ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { rolesForUser } from '../auth/grants.js'
import {
	type Capability,
	deniedMessage,
	may,
	ROLE_ADMIN,
} from '../auth/roles.js'

/**
 * Wer spricht gerade mit dem MCP-Server, und was darf er?
 *
 * Der Wert entsteht aus dem Bearer-Token (`src/server/oauth/provider.ts`),
 * das seine Rollen aus dem Anmeldevorgang mitgebracht hat. Ein MCP-Client hat
 * kein Sitzungs-Cookie, deshalb ist das Token hier die einzige Quelle.
 */
export type McpAuth = {
	/** ZITADEL-`sub` der Person, in deren Namen der Client arbeitet. */
	userId: string
	/**
	 * Rollen NUR fuer Tests direkt setzbar. Im Betrieb bleibt das Feld leer
	 * und die Rollen werden pro Aufruf bei ZITADEL erfragt — siehe
	 * `rolesFor` weiter unten.
	 */
	roles?: string[]
}

/**
 * Liest `McpAuth` aus dem, was die Bearer-Middleware an den Request gehaengt
 * hat. Fehlt etwas, bleibt die Rollenliste leer — dann sind nur lesende Tools
 * benutzbar. Kein stillschweigendes "wird schon Admin sein".
 */
export const authFromInfo = (info: AuthInfo | undefined): McpAuth => {
	const extra = (info?.extra ?? {}) as { userId?: unknown }
	return { userId: typeof extra.userId === 'string' ? extra.userId : '' }
}

/**
 * Die Rollen dieses Aufrufers — bei JEDEM Werkzeugaufruf frisch aus ZITADEL.
 *
 * Das Bearer-Token traegt nur die Identitaet. Truege es die Rollen, waere ein
 * ENTZOGENES Recht nie wieder loszuwerden: der Client erneuert sein Token
 * selbsttaetig, und ein Refresh reichte die alten Rollen einfach durch. Genau
 * dieser Fehler war hier gebaut und ist der Grund fuer diese Funktion.
 *
 * `auth.roles` wird nur in Tests gesetzt; im Betrieb ist es leer.
 */
export const rolesFor = async (auth: McpAuth): Promise<string[]> =>
	auth.roles ?? rolesForUser(auth.userId)

/**
 * Zweiter Parameter von `McpServer#registerTool` — die Tool-Beschreibung.
 * Nachgebaut statt per `Parameters<...>` abgeleitet: `registerTool` ist
 * generisch, und `Parameters<...>` instanziiert die Generics mit ihren
 * Vorgaben. `inputSchema` waere dabei zu `undefined` eingefroren und die
 * Argumenttypen aller Handler zu `any` zerfallen.
 */
type GuardedToolConfig<
	InputArgs extends undefined | ZodRawShapeCompat | AnySchema,
	OutputArgs extends ZodRawShapeCompat | AnySchema,
> = {
	title?: string
	description?: string
	inputSchema?: InputArgs
	outputSchema?: OutputArgs
	annotations?: ToolAnnotations
	_meta?: Record<string, unknown>
}

const HINT: Record<Capability, string> = {
	lesen: '',
	personen: `\n\nLiefert personenbezogene Daten und erfordert deshalb die Rolle "${ROLE_ADMIN}" im ZITADEL-Projekt dieser Klasse.`,
	bearbeiten: `\n\nAendert Daten und erfordert deshalb die Rolle "${ROLE_ADMIN}" im ZITADEL-Projekt dieser Klasse.`,
}

/**
 * Registriert ein Tool, das mehr braucht als blosses Lesen.
 *
 * `capability` sagt WARUM: `personen` fuer alles, was Namen und Adressen
 * herausgibt, `bearbeiten` fuer alles, was schreibt oder verschickt. Der
 * Unterschied zu `server.registerTool` ist die eine Zeile `may(...)` darin —
 * dieselbe Funktion, die auch die Weboberflaeche fragt
 * (`src/server/auth/roles.ts`).
 *
 * Dass die Pruefung an der REGISTRIERUNG haengt und nicht im Rumpf jedes
 * einzelnen Handlers, ist Absicht: es gibt genau einen Ort, an dem sie stehen
 * kann, also kann sie nicht in einem von fuenfundzwanzig Handlern fehlen.
 *
 * Das Tool bleibt bewusst SICHTBAR, auch wenn der Aufrufer es nicht benutzen
 * darf. Ein Client, dem `upsert_mitglied` gar nicht erst angeboten wird,
 * meldet "unbekanntes Werkzeug" — der Mensch davor sucht den Fehler dann im
 * Server statt in seiner Berechtigung. Stattdessen kommt ein klarer Text, der
 * sagt, welche Rolle fehlt und wer sie vergibt.
 */
export const registerGuardedTool = <
	OutputArgs extends ZodRawShapeCompat | AnySchema = ZodRawShapeCompat,
	InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
	server: McpServer,
	auth: McpAuth,
	capability: Capability,
	name: string,
	config: GuardedToolConfig<InputArgs, OutputArgs>,
	cb: ToolCallback<InputArgs>,
): RegisteredTool =>
	server.registerTool<OutputArgs, InputArgs>(
		name,
		{
			...config,
			description: `${config.description ?? ''}${HINT[capability]}`,
		},
		// Die Argumente werden nur durchgereicht. Ihr Typ haengt am generischen
		// `InputArgs` und ist an dieser Stelle kein Tupel, das man spreizen
		// koennte — nach aussen bleibt die Signatur durch `ToolCallback<InputArgs>`
		// aber exakt die des SDK, und die Handler behalten ihre echten Typen.
		(async (...args: unknown[]) => {
			let roles: string[]
			try {
				roles = await rolesFor(auth)
			} catch (error) {
				// Verweigern statt durchwinken. ZITADEL laeuft im selben Cluster;
				// antwortet es nicht, ist das ein Ausfall und kein Normalfall.
				return {
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: `Berechtigung konnte nicht geprueft werden: ${(error as Error).message}`,
						},
					],
				}
			}
			if (!may(roles, capability)) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: deniedMessage(capability) }],
				}
			}
			return (cb as (...passed: unknown[]) => unknown)(...args)
		}) as ToolCallback<InputArgs>,
	)

/**
 * Werkzeug, das nur LIEST, was ohnehin jeder Angemeldete sehen darf: welche
 * Verteiler es gibt, welche Gruppen sie erreichen.
 *
 * Auch das geht durch den Waechter, und zwar aus einem konkreten Grund: Ein
 * Bearer-Token ueberlebt die Person. Wer die Klasse verlaesst, verliert
 * seinen Grant — sein Token bleibt aber gueltig, bis es ablaeuft. Ohne diese
 * Pruefung koennte er weiter aufzaehlen, welche Verteiler es gibt. Mit ihr
 * faellt er auf `lesen` durch, sobald der Grant weg ist. Gemessen an einem
 * echten Token, dessen Konto geloescht wurde.
 */
export const registerReadTool = <
	OutputArgs extends ZodRawShapeCompat | AnySchema = ZodRawShapeCompat,
	InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
	server: McpServer,
	auth: McpAuth,
	name: string,
	config: GuardedToolConfig<InputArgs, OutputArgs>,
	cb: ToolCallback<InputArgs>,
): RegisteredTool =>
	registerGuardedTool(server, auth, 'lesen', name, config, cb)

/** Werkzeug, das Daten AENDERT oder verschickt. */
export const registerWriteTool = <
	OutputArgs extends ZodRawShapeCompat | AnySchema = ZodRawShapeCompat,
	InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
	server: McpServer,
	auth: McpAuth,
	name: string,
	config: GuardedToolConfig<InputArgs, OutputArgs>,
	cb: ToolCallback<InputArgs>,
): RegisteredTool =>
	registerGuardedTool(server, auth, 'bearbeiten', name, config, cb)

/**
 * Werkzeug, das PERSONENBEZOGENE Daten herausgibt — Namen, Adressen,
 * wer auf welcher Liste steht, wer was bekommen hat.
 *
 * Bewusst getrennt von `registerWriteTool`, obwohl heute dieselbe Rolle
 * dahintersteht: an der Aufrufstelle soll ablesbar sein, dass hier Daten
 * ueber andere Familien herausgehen und nicht bloss etwas veraendert wird.
 */
export const registerPersonalDataTool = <
	OutputArgs extends ZodRawShapeCompat | AnySchema = ZodRawShapeCompat,
	InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
	server: McpServer,
	auth: McpAuth,
	name: string,
	config: GuardedToolConfig<InputArgs, OutputArgs>,
	cb: ToolCallback<InputArgs>,
): RegisteredTool =>
	registerGuardedTool(server, auth, 'personen', name, config, cb)
