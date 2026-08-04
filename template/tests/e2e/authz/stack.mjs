#!/usr/bin/env node
/**
 * Der vollstaendige Stack fuer die Autorisierungs-Tests: PostgreSQL, ein
 * ECHTES ZITADEL, dessen Login v2 und diese Anwendung — alles lokal, alles
 * wegwerfbar.
 *
 * Warum kein Mock und keine Testinstanz im Netz:
 *
 *   Ein nachgebautes ZITADEL prueft den Nachbau, nicht die Wirklichkeit.
 *   Genau die drei Fehler, gegen die diese Tests stehen — Rollen im Token
 *   veralten, eine neu vergebene Rolle kommt nicht an, ein Entzug wirkt nie —
 *   haette ein Mock nicht gezeigt: er bildet das Verhalten nach, das man
 *   erwartet, und die Fehler bestanden gerade darin, dass die Wirklichkeit
 *   anders war.
 *
 *   Eine laufende Instanz im Netz (`id.example.org`) scheidet
 *   ebenfalls aus. Diese Tests VERGEBEN und ENTZIEHEN Rollen — gegen einen
 *   produktiven Verzeichnisdienst gerichtet heisst das, dass ein
 *   fehlgeschlagener Lauf irgendwann einem echten Elternteil den Zugang
 *   nimmt. Ausserdem braeuchte die CI dafuer ein Betriebs-Credential, und
 *   eine CI mit Betriebs-Credential IST eine Produktionsschnittstelle.
 *
 * Alles, was die Tests an Zugangsdaten brauchen, erzeugt diese Instanz sich
 * selbst: ZITADEL legt beim ersten Start einen Dienstnutzer an und schreibt
 * dessen Personal Access Token in eine Datei (`FIRSTINSTANCE_PATPATH`).
 * Damit — und nur damit — werden Org, Projekte, Rollen und Testnutzer
 * angelegt. Es gibt keinen Weg von hier zu irgendetwas Produktivem.
 *
 * Aufrufe:
 *   node tests/e2e/authz/stack.mjs up     Container starten, einrichten, App starten
 *   node tests/e2e/authz/stack.mjs down   alles wieder abraeumen
 *   node tests/e2e/authz/stack.mjs logs   Logs aller Teile ausgeben (CI bei Fehlschlag)
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

/** Arbeitsverzeichnis des Stacks. Liegt im Repo, damit `docker -v` es sieht. */
const workDir = resolve(here, '.stack')
const statePath = resolve(workDir, 'stack.json')
const appLogPath = resolve(workDir, 'app.log')
const patDir = resolve(workDir, 'pat')

/**
 * Versionen. Bewusst gepinnt und bewusst dieselbe wie im Betrieb: ein Test
 * gegen eine andere ZITADEL-Version prueft ein anderes Verhalten.
 */
const ZITADEL_IMAGE = 'ghcr.io/zitadel/zitadel:v4.13.1'
const LOGIN_IMAGE = 'ghcr.io/zitadel/zitadel-login:v4.13.1'
const POSTGRES_IMAGE = 'postgres:17-alpine'

const num = (name, fallback) =>
	Number.parseInt(process.env[name] ?? String(fallback), 10)

const ports = {
	zitadel: num('AUTHZ_ZITADEL_PORT', 8080),
	login: num('AUTHZ_LOGIN_PORT', 3001),
	app: num('AUTHZ_APP_PORT', 4322),
}

const names = {
	postgres: 'fws-authz-postgres',
	zitadel: 'fws-authz-zitadel',
	login: 'fws-authz-login',
}

const network = 'fws-authz-net'

const issuer = `http://localhost:${ports.zitadel}`
const loginBaseUri = `http://localhost:${ports.login}/ui/v2/login`
const appOrigin = `http://localhost:${ports.app}`

/**
 * Der Masterkey ist hartkodiert und darf das sein: er verschluesselt die
 * Daten EINER Wegwerf-Instanz, die am Ende jedes Laufs geloescht wird. Ein
 * Geheimnis waere hier ein Geheimnis ohne Geheimzuhaltendes.
 */
const MASTERKEY = 'MasterkeyNeedsToHave32Characters'

/**
 * Der Name des ZITADEL-Projekts dieser Klasse und der der Nachbarklasse.
 *
 * Sie stehen hier und nicht in `src/site.config.ts`, weil beide fuer den Test
 * frei erfunden sein DUERFEN: geprueft wird, dass zwei getrennte Projekte mit
 * gleichnamigen Rollen sich nicht gegenseitig aufsperren — nicht, wie die
 * Projekte im Betrieb heissen.
 */
const OWN_PROJECT = 'klasse-musterfrau'
const OTHER_PROJECT = 'klasse-nachbar'

// --- kleine Helfer ---------------------------------------------------------

const log = (message) => console.log(`[stack] ${message}`)

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		...options,
	})
	if (result.status !== 0 && !options.allowFailure) {
		throw new Error(
			`${command} ${args.join(' ')} scheiterte (${result.status}):\n${result.stderr ?? ''}${result.stdout ?? ''}`,
		)
	}
	return (result.stdout ?? '').trim()
}

const docker = (args, options = {}) => run('docker', args, options)

/**
 * Logs eines Containers, BEIDE Stroeme.
 *
 * ZITADEL und PostgreSQL schreiben nach stderr. Wer hier nur stdout einsammelt,
 * bekommt bei einem Fehlschlag eine leere Ausgabe zu sehen und sucht den Fehler
 * anschliessend an der falschen Stelle — genau das ist beim ersten CI-Lauf
 * passiert.
 */
const containerLogs = (name) => {
	const result = spawnSync('docker', ['logs', '--tail', '200', name], {
		encoding: 'utf8',
	})
	return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

/** Laeuft der Container noch? */
const isRunning = (name) =>
	docker(['inspect', '-f', '{{.State.Running}}', name], {
		allowFailure: true,
	}) === 'true'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Weiterwarten ist sinnlos — die Ursache steht schon fest. */
class AbortSetup extends Error {}

/**
 * Wartet auf eine Bedingung. Der `label` landet in der Fehlermeldung — eine
 * CI, die nur "timeout" meldet, kostet beim naechsten Mal eine halbe Stunde.
 */
const waitFor = async (label, check, timeoutMs = 180_000) => {
	const started = Date.now()
	let lastError = ''
	while (Date.now() - started < timeoutMs) {
		try {
			if (await check()) {
				log(
					`${label}: bereit nach ${Math.round((Date.now() - started) / 1000)}s`,
				)
				return
			}
		} catch (error) {
			if (error instanceof AbortSetup) throw error
			lastError = String(error)
		}
		await sleep(500)
	}
	throw new Error(
		`${label}: nicht bereit nach ${timeoutMs / 1000}s. Letzter Fehler: ${lastError}`,
	)
}

// --- ZITADEL-API -----------------------------------------------------------

/**
 * Ruft die ZITADEL-API der lokalen Instanz auf. `token` ist immer ein
 * Credential, das DIESE Instanz gerade selbst ausgestellt hat.
 */
const api = async (token, method, path, body) => {
	const response = await fetch(`${issuer}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await response.text()
	if (!response.ok) {
		throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text}`)
	}
	return text ? JSON.parse(text) : {}
}

// --- Aufbau ----------------------------------------------------------------

const startPostgres = () => {
	docker(['network', 'create', network], { allowFailure: true })
	docker(['rm', '-f', names.postgres], { allowFailure: true })
	docker([
		'run',
		'-d',
		'--name',
		names.postgres,
		'--network',
		network,
		'-e',
		'POSTGRES_USER=postgres',
		'-e',
		'POSTGRES_PASSWORD=postgres',
		// Kein Volume: die Datenbank lebt genau so lange wie der Lauf. Ein
		// Rest von gestern waere die Sorte Zustand, die Tests unerklaerlich
		// macht.
		'--tmpfs',
		'/var/lib/postgresql/data',
		POSTGRES_IMAGE,
	])
	// Bewusst ueber TCP (`-h 127.0.0.1`) und nicht ueber den Unix-Socket.
	// Das offizielle Image startet beim ersten Mal einen VORLAEUFIGEN Server,
	// der nur auf dem Socket lauscht, spielt die Initialisierung ein und
	// startet danach neu. Ein `pg_isready` ohne Host meldet in dieser Phase
	// schon Erfolg — ZITADEL startet dann los, findet keinen erreichbaren
	// Server und beendet sich. Genau so ist der erste CI-Lauf gescheitert:
	// lokal war das Fenster zu kurz, um aufzufallen, auf dem Runner nicht.
	return waitFor(
		'postgres',
		() =>
			spawnSync(
				'docker',
				[
					'exec',
					names.postgres,
					'pg_isready',
					'-h',
					'127.0.0.1',
					'-p',
					'5432',
					'-U',
					'postgres',
				],
				{ encoding: 'utf8' },
			).status === 0,
		120_000,
	)
}

const startZitadel = async () => {
	docker(['rm', '-f', names.zitadel], { allowFailure: true })
	rmSync(patDir, { recursive: true, force: true })
	mkdirSync(patDir, { recursive: true })
	// Fuer alle beschreibbar, und das ist noetig: ZITADEL laeuft im Container
	// unter einer eigenen Benutzerkennung und legt hier sein Personal Access
	// Token ab. Auf dem CI-Runner gehoert das Verzeichnis einer anderen Kennung
	// als der im Container, und der Aufbau starb mit
	// "open /pat/admin.pat: permission denied" — auf dem Entwicklungsrechner
	// fielen beide Kennungen zufaellig zusammen und es fiel nicht auf.
	// Unbedenklich: das Verzeichnis liegt im Arbeitsbaum eines Testlaufs und
	// wird beim naechsten `up` geloescht.
	chmodSync(patDir, 0o777)
	docker([
		'run',
		'-d',
		'--name',
		names.zitadel,
		'--network',
		network,
		// Beide Adressen, unter denen von aussen etwas erreichbar sein muss:
		// ZITADEL selbst und — im selben Netzwerk-Namensraum — die
		// Anmeldeoberflaeche. Siehe `startLoginUi`.
		'-p',
		`${ports.zitadel}:${ports.zitadel}`,
		'-p',
		`${ports.login}:${ports.login}`,
		'-v',
		`${patDir}:/pat`,
		'-e',
		`ZITADEL_DATABASE_POSTGRES_HOST=${names.postgres}`,
		'-e',
		'ZITADEL_DATABASE_POSTGRES_PORT=5432',
		'-e',
		'ZITADEL_DATABASE_POSTGRES_DATABASE=zitadel',
		'-e',
		'ZITADEL_DATABASE_POSTGRES_USER_USERNAME=zitadel',
		'-e',
		'ZITADEL_DATABASE_POSTGRES_USER_PASSWORD=zitadel',
		'-e',
		'ZITADEL_DATABASE_POSTGRES_USER_SSL_MODE=disable',
		'-e',
		'ZITADEL_DATABASE_POSTGRES_ADMIN_USERNAME=postgres',
		'-e',
		'ZITADEL_DATABASE_POSTGRES_ADMIN_PASSWORD=postgres',
		'-e',
		'ZITADEL_DATABASE_POSTGRES_ADMIN_SSL_MODE=disable',
		'-e',
		'ZITADEL_EXTERNALSECURE=false',
		'-e',
		'ZITADEL_EXTERNALDOMAIN=localhost',
		'-e',
		`ZITADEL_EXTERNALPORT=${ports.zitadel}`,
		'-e',
		`ZITADEL_PORT=${ports.zitadel}`,
		'-e',
		'ZITADEL_TLS_ENABLED=false',
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_NAME=fws-maschsee-e2e',
		// Der Instanz-Administrator. ZITADEL legt ohne diese Angaben von sich
		// aus `zitadel-admin@zitadel.<domain>` mit dem Herstellerpasswort
		// `Password1!` an. Verlassen wollen wir uns darauf nicht, deshalb steht
		// er hier ausgeschrieben — und wird ausserdem gar nicht gebraucht: die
		// Einrichtung laeuft ueber den Dienstnutzer und dessen PAT.
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME=e2e-root',
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD=Password1!',
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORDCHANGEREQUIRED=false',
		// Dienstnutzer plus PAT — das einzige Credential, mit dem diese Tests
		// arbeiten. Es entsteht hier, es gilt nur hier, und es faellt mit dem
		// Container.
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=e2e-admin-sa',
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_NAME=E2E Admin',
		// Ohne ExpirationDate legt ZITADEL gar kein PAT an und schreibt
		// entsprechend auch keine Datei — der Lauf haengt dann beim Warten
		// darauf. Gemessen an v4.13.1.
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_MACHINE_PAT_EXPIRATIONDATE=2999-01-01T00:00:00Z',
		'-e',
		'ZITADEL_FIRSTINSTANCE_PATPATH=/pat/admin.pat',
		ZITADEL_IMAGE,
		'start-from-init',
		'--masterkey',
		MASTERKEY,
		'--tlsMode',
		'disabled',
	])

	await waitFor('zitadel (bereit)', async () => {
		// Erst nachsehen, ob es ueberhaupt noch etwas gibt, worauf man warten
		// koennte. Ohne diese Pruefung laeuft der Aufbau in die volle
		// Zeitgrenze und meldet "nicht bereit" — waehrend der Container laengst
		// mit einer klaren Begruendung im Log gestorben ist.
		if (!isRunning(names.zitadel)) {
			throw new AbortSetup(
				`Der ZITADEL-Container ist beendet. Sein Log:\n${containerLogs(names.zitadel)}`,
			)
		}
		const response = await fetch(`${issuer}/debug/ready`)
		return response.status === 200 && existsSync(resolve(patDir, 'admin.pat'))
	})
	const adminToken = readFileSync(resolve(patDir, 'admin.pat'), 'utf8').trim()

	// Zweite Stufe, und sie ist noetig: `/debug/ready` meldet 200 und das PAT
	// liegt schon da, waehrend die Verwaltungs-API noch mit
	// „dial tcp [::1]:8080: connection refused" antwortet — ZITADEL spricht
	// intern ueber dieselbe Adresse mit sich selbst und nimmt dort noch keine
	// Verbindungen an. Ohne diese Wartestufe scheitert der Aufbau in etwa
	// jedem zweiten Lauf, und zwar an einer Stelle, die nach einem
	// Konfigurationsfehler aussieht.
	await waitFor('zitadel (verwaltungs-api)', async () => {
		const response = await fetch(`${issuer}/management/v1/orgs/me`, {
			headers: { Authorization: `Bearer ${adminToken}` },
		})
		return response.status === 200
	})

	return adminToken
}

/**
 * Login v2 — dieselbe Anmeldeoberflaeche wie im Betrieb.
 *
 * In ZITADEL v4 ist das eine EIGENE Anwendung: der Kern leitet nur noch auf
 * `loginV2.baseUri` um. Ohne diesen Container antwortet `/ui/v2/login` mit
 * 404 und jede Anmeldung endet im Nichts. Der Container braucht ein Token
 * eines Dienstnutzers mit der Rolle `IAM_LOGIN_CLIENT`; auch das legen wir
 * hier selbst an.
 *
 * Er laeuft im NETZWERK-NAMENSRAUM des ZITADEL-Containers
 * (`--network container:...`). Das ist kein Kunstgriff, sondern loest ein
 * konkretes Problem: ZITADEL beantwortet Anfragen nur unter dem einen
 * Hostnamen, auf den seine Instanz laeuft (`ExternalDomain=localhost`) —
 * unter jedem anderen antwortet es „Instance not found". Im geteilten
 * Namensraum ist `http://localhost:8080` fuer die Anmeldeoberflaeche
 * dieselbe Adresse wie fuer den Browser und fuer die Anwendung. Es gibt
 * damit gar keine zweite Adresse, unter der etwas schiefgehen koennte.
 */
const startLoginUi = async (adminToken) => {
	const machine = await api(
		adminToken,
		'POST',
		'/management/v1/users/machine',
		{
			userName: 'e2e-login-client',
			name: 'E2E Login Client',
			description: 'Login v2',
			accessTokenType: 'ACCESS_TOKEN_TYPE_BEARER',
		},
	)
	const pat = await api(
		adminToken,
		'POST',
		`/management/v1/users/${machine.userId}/pats`,
		{ expirationDate: '2999-01-01T00:00:00Z' },
	)
	await api(adminToken, 'POST', '/admin/v1/members', {
		userId: machine.userId,
		roles: ['IAM_LOGIN_CLIENT'],
	})
	await api(adminToken, 'PUT', '/v2/features/instance', {
		loginV2: { required: true, baseUri: loginBaseUri },
	})

	docker(['rm', '-f', names.login], { allowFailure: true })
	docker([
		'run',
		'-d',
		'--name',
		names.login,
		'--network',
		`container:${names.zitadel}`,
		'-e',
		`ZITADEL_API_URL=${issuer}`,
		'-e',
		`ZITADEL_SERVICE_USER_TOKEN=${pat.token}`,
		'-e',
		'NEXT_PUBLIC_BASE_PATH=/ui/v2/login',
		'-e',
		`PORT=${ports.login}`,
		LOGIN_IMAGE,
	])

	await waitFor('login v2', async () => {
		const response = await fetch(`${loginBaseUri}/loginname`, {
			redirect: 'manual',
		})
		return response.status < 500
	})
}

/**
 * Anmelderichtlinie der Testinstanz: Kennung und Kennwort, sonst nichts.
 *
 * Ohne das bietet Login v2 nach dem Kennwort noch die Einrichtung eines
 * zweiten Faktors bzw. eines Passkeys an. Diese Zwischenseite haette in
 * jedem Anmeldevorgang einen zusaetzlichen, von der ZITADEL-Version
 * abhaengigen Klick noetig gemacht — die klassische Quelle eines Tests, der
 * gelegentlich rot ist. Geprueft wird hier die AUTORISIERUNG; wie stark die
 * Authentisierung ist, ist eine andere Frage und im Betrieb anders
 * beantwortet.
 */
const relaxLoginPolicy = (adminToken) =>
	api(adminToken, 'PUT', '/admin/v1/policies/login', {
		allowUsernamePassword: true,
		allowRegister: false,
		allowExternalIdp: false,
		forceMfa: false,
		forceMfaLocalOnly: false,
		passwordlessType: 'PASSWORDLESS_TYPE_NOT_ALLOWED',
		hidePasswordReset: true,
		ignoreUnknownUsernames: false,
		disableLoginWithEmail: false,
		disableLoginWithPhone: true,
		// Die Fristen sind bewusst 0 = „nie erzwingen". Ein Testlauf dauert
		// Minuten, aber eine gesetzte Frist macht das Verhalten von der Uhr
		// abhaengig.
		passwordCheckLifetime: '864000s',
		externalLoginCheckLifetime: '864000s',
		mfaInitSkipLifetime: '0s',
		secondFactorCheckLifetime: '864000s',
		multiFactorCheckLifetime: '864000s',
	})

/**
 * Legt ein Klassenprojekt an: Rollen `mitglied` und `admin`, dazu einen
 * OIDC-Client, wenn diese Klasse die getestete ist.
 *
 * `projectRoleAssertion` ist der Schalter, an dem alles haengt: nur damit
 * legt ZITADEL die Projektrollen ueberhaupt in die Token. `projectRoleCheck`
 * bleibt AUS — sonst wiese ZITADEL Nutzer ohne Grant schon selbst ab, und die
 * Seite "angemeldet, aber noch nicht freigeschaltet" der Anwendung bekaeme
 * nie jemand zu sehen. Genau die soll aber geprueft werden.
 */
const createProject = async (adminToken, name) => {
	const project = await api(adminToken, 'POST', '/management/v1/projects', {
		name,
		projectRoleAssertion: true,
		projectRoleCheck: false,
		hasProjectCheck: false,
	})
	for (const role of ['mitglied', 'admin']) {
		await api(
			adminToken,
			'POST',
			`/management/v1/projects/${project.id}/roles`,
			{ roleKey: role, displayName: role },
		)
	}
	return project.id
}

const createOidcClient = async (adminToken, projectId) =>
	api(adminToken, 'POST', `/management/v1/projects/${projectId}/apps/oidc`, {
		name: 'website',
		redirectUris: [`${appOrigin}/auth/callback`],
		postLogoutRedirectUris: [`${appOrigin}/`],
		responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
		grantTypes: [
			'OIDC_GRANT_TYPE_AUTHORIZATION_CODE',
			// Ohne Refresh-Grant kann die Anwendung ihre Sitzung nicht
			// verlaengern — und genau daran haengt, ob ein Rechteentzug wirkt.
			'OIDC_GRANT_TYPE_REFRESH_TOKEN',
		],
		appType: 'OIDC_APP_TYPE_WEB',
		authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
		accessTokenType: 'OIDC_TOKEN_TYPE_BEARER',
		accessTokenRoleAssertion: true,
		idTokenRoleAssertion: true,
		idTokenUserinfoAssertion: true,
		devMode: true,
	})

/**
 * Der Dienstzugang, mit dem die ANWENDUNG bei ZITADEL nachfragt, wer was darf.
 *
 * Seit die Rollen nicht mehr im Token stehen, sondern bei jeder Anfrage frisch
 * erfragt werden (`src/server/auth/grants.ts`), braucht die Anwendung ein
 * eigenes Credential. Im Betrieb kommt es aus einem SealedSecret; hier stellt
 * die Wegwerf-Instanz es sich selbst aus. Ohne diesen Schritt antwortet die
 * Anwendung auf jeder geschuetzten Seite mit 503 „Berechtigungspruefung nicht
 * konfiguriert" — richtig so, aber schwer zu deuten, wenn man es nicht
 * erwartet.
 *
 * `ORG_USER_MANAGER` statt `ORG_OWNER`: die Anwendung muss Nutzer und deren
 * Grants LESEN, sonst nichts. Ein Testaufbau, der dem Dienst mehr gibt als
 * noetig, verschweigt genau den Fehler, der im Betrieb weh taete — dass die
 * hinterlegte Rolle zu schwach ist.
 */
const createAppServiceUser = async (adminToken) => {
	const machine = await api(
		adminToken,
		'POST',
		'/management/v1/users/machine',
		{
			userName: 'e2e-app',
			name: 'E2E Anwendung',
			description: 'Fragt Berechtigungen bei ZITADEL ab',
			accessTokenType: 'ACCESS_TOKEN_TYPE_BEARER',
		},
	)
	const pat = await api(
		adminToken,
		'POST',
		`/management/v1/users/${machine.userId}/pats`,
		{ expirationDate: '2999-01-01T00:00:00Z' },
	)
	await api(adminToken, 'POST', '/management/v1/orgs/me/members', {
		userId: machine.userId,
		roles: ['ORG_USER_MANAGER'],
	})
	return pat.token
}

/**
 * Testnutzer. Erfundene Namen, `@example.invalid` als Domain: die ist per RFC
 * 2606 garantiert nicht aufloesbar, an sie kann also auch versehentlich keine
 * Mail gehen. Echte Elterndaten haben in Tests nichts verloren.
 */
const TEST_PASSWORD = 'E2e-Testpasswort-1!'

const createUser = async (adminToken, key, firstName, lastName) => {
	const email = `e2e-${key}@example.invalid`
	const user = await api(
		adminToken,
		'POST',
		'/management/v1/users/human/_import',
		{
			userName: email,
			profile: { firstName, lastName },
			email: { email, isEmailVerified: true },
			password: TEST_PASSWORD,
			passwordChangeRequired: false,
		},
	)
	return { key, userId: user.userId, email, password: TEST_PASSWORD }
}

const grant = async (adminToken, userId, projectId, roles) => {
	const created = await api(
		adminToken,
		'POST',
		`/management/v1/users/${userId}/grants`,
		{ projectId, roleKeys: roles },
	)
	return created.userGrantId
}

const setup = async () => {
	mkdirSync(workDir, { recursive: true })

	log('PostgreSQL starten')
	await startPostgres()

	log('ZITADEL starten (erste Instanz wird dabei angelegt)')
	const adminToken = await startZitadel()

	log('Login v2 starten')
	await startLoginUi(adminToken)

	log('Anmelderichtlinie auf Kennung und Kennwort beschraenken')
	await relaxLoginPolicy(adminToken)

	log('Projekte, Rollen und Nutzer anlegen')
	// BEIDE Klassen. Der wichtigste Test ist der, dass ein `mitglied` der
	// Nachbarklasse hier NICHT hereinkommt — dafuer muss es die Nachbarklasse
	// als eigenes Projekt geben, mit einer gleichnamigen Rolle darin.
	const ownProjectId = await createProject(adminToken, OWN_PROJECT)
	const otherProjectId = await createProject(adminToken, OTHER_PROJECT)
	const client = await createOidcClient(adminToken, ownProjectId)

	// Die Org, in der alles liegt. Die Anwendung schickt ihre ID als
	// `x-zitadel-orgid` mit — ohne sie sucht ZITADEL in der falschen.
	const org = await api(adminToken, 'GET', '/management/v1/orgs/me')
	const appServiceToken = await createAppServiceUser(adminToken)

	const users = {}

	const mitglied = await createUser(adminToken, 'mitglied', 'Mira', 'Meissner')
	mitglied.grantId = await grant(adminToken, mitglied.userId, ownProjectId, [
		'mitglied',
	])
	users.mitglied = mitglied

	const admin = await createUser(adminToken, 'admin', 'Anton', 'Ahrend')
	admin.grantId = await grant(adminToken, admin.userId, ownProjectId, [
		'mitglied',
		'admin',
	])
	users.admin = admin

	// Nur in der NACHBARKLASSE berechtigt — gleiche Rolle, anderes Projekt.
	const fremd = await createUser(adminToken, 'fremd', 'Frieda', 'Feldmann')
	fremd.grantId = await grant(adminToken, fremd.userId, otherProjectId, [
		'mitglied',
	])
	users.fremd = fremd

	// Eigene Nutzer fuer Entzug und Vergabe, damit die Tests einander nicht
	// beeinflussen und in beliebiger Reihenfolge laufen koennen.
	const entzug = await createUser(adminToken, 'entzug', 'Enno', 'Ehlers')
	entzug.grantId = await grant(adminToken, entzug.userId, ownProjectId, [
		'mitglied',
		'admin',
	])
	users.entzug = entzug

	const vergabe = await createUser(adminToken, 'vergabe', 'Vera', 'Voelker')
	vergabe.grantId = await grant(adminToken, vergabe.userId, ownProjectId, [
		'mitglied',
	])
	users.vergabe = vergabe

	// Fuer den MCP-Endpunkt noch einmal dasselbe Paar. Eigene Nutzer, weil die
	// Tests die Rollen dieser Konten VERAENDERN: teilten sich Oberflaeche und
	// MCP-Endpunkt dieselben, haenge das Ergebnis des zweiten Tests daran, ob
	// der erste vorher gelaufen ist.
	const mcpEntzug = await createUser(adminToken, 'mcp-entzug', 'Mika', 'Ewers')
	mcpEntzug.grantId = await grant(adminToken, mcpEntzug.userId, ownProjectId, [
		'mitglied',
		'admin',
	])
	users.mcpEntzug = mcpEntzug

	const mcpVergabe = await createUser(adminToken, 'mcp-vergabe', 'Nele', 'Vogt')
	mcpVergabe.grantId = await grant(
		adminToken,
		mcpVergabe.userId,
		ownProjectId,
		['mitglied'],
	)
	users.mcpVergabe = mcpVergabe

	// Fuer den Widerruf einer verbundenen Anwendung in der Oberflaeche.
	const mcpWiderruf = await createUser(
		adminToken,
		'mcp-widerruf',
		'Wiebke',
		'Ruhnke',
	)
	mcpWiderruf.grantId = await grant(
		adminToken,
		mcpWiderruf.userId,
		ownProjectId,
		['mitglied', 'admin'],
	)
	users.mcpWiderruf = mcpWiderruf

	// Angemeldet, aber ueberhaupt nirgends berechtigt.
	const ohne = await createUser(adminToken, 'ohnerolle', 'Olaf', 'Osterhage')
	users.ohnerolle = ohne

	return {
		issuer,
		loginBaseUri,
		appOrigin,
		adminToken,
		orgId: org.org.id,
		appServiceToken,
		ownProjectId,
		otherProjectId,
		clientId: client.clientId,
		clientSecret: client.clientSecret,
		sessionSecret: randomBytes(32).toString('hex'),
		users,
	}
}

// --- Anwendung -------------------------------------------------------------

const appEnv = (state) => ({
	...process.env,
	NODE_ENV: 'production',
	// DISABLE_AUTH ist hier ausdruecklich NICHT gesetzt. Der Smoke-Test unter
	// tests/e2e/ schaltet die Anmeldung ab, weil er Inhalte prueft; diese
	// Tests pruefen die Anmeldung selbst.
	DISABLE_AUTH: '',
	PORT: String(ports.app),
	OIDC_ISSUER: state.issuer,
	OIDC_CLIENT_ID: state.clientId,
	OIDC_CLIENT_SECRET: state.clientSecret,
	OIDC_REQUIRED_ROLE: 'mitglied',
	SESSION_SECRET: state.sessionSecret,
	// Massgeblich fuer redirect_uri und Cookie-Flags. Ohne diesen Wert haengt
	// beides daran, wie das Framework gerade den Host-Header auslegt.
	OIDC_PUBLIC_ORIGIN: appOrigin,
	PUBLIC_BASE_URL: appOrigin,
	// Womit die Anwendung bei JEDER Anfrage nachfragt, wer was darf. Die
	// Rollen stehen bewusst nicht mehr im Token — sonst waere ein Entzug
	// wieder eine Momentaufnahme (src/server/auth/grants.ts).
	ZITADEL_ISSUER: state.issuer,
	ZITADEL_ORG_ID: state.orgId,
	ZITADEL_PROJECT_ID: state.ownProjectId,
	ZITADEL_SERVICE_TOKEN: state.appServiceToken,
	MCP_INSTANCE_NAME: OWN_PROJECT,
	MCP_INSTANCE_LABEL: OWN_PROJECT,
	DB_PATH: './data/authz-e2e.db',
	DATABASE_URL: 'sqlite:./data/authz-e2e.db',
})

const buildAndStartApp = async (state) => {
	// Frische Datenbank. Ein Rest vom letzten Lauf koennte einen Test gruen
	// machen, der eigentlich nichts angelegt hat.
	rmSync(resolve(repoRoot, 'data/authz-e2e.db'), { force: true })
	rmSync(resolve(repoRoot, 'data/authz-e2e.db-wal'), { force: true })
	rmSync(resolve(repoRoot, 'data/authz-e2e.db-shm'), { force: true })
	mkdirSync(resolve(repoRoot, 'data'), { recursive: true })

	const env = appEnv(state)
	log('Anwendung bauen')
	run('npm', ['run', 'build'], { cwd: repoRoot, env, stdio: 'inherit' })
	log('Migrationen einspielen')
	run('npm', ['run', 'db:migrate'], { cwd: repoRoot, env, stdio: 'inherit' })

	log('Anwendung starten')
	const logFd = openSync(appLogPath, 'w')
	const child = spawn('npm', ['start'], {
		cwd: repoRoot,
		env,
		detached: true,
		stdio: ['ignore', logFd, logFd],
	})
	child.unref()

	await waitFor(
		'anwendung',
		async () => {
			const response = await fetch(`${appOrigin}/auth/login`, {
				redirect: 'manual',
			})
			// 302 zum Anmeldedienst ist die gesunde Antwort eines Servers, dessen
			// Anmeldung konfiguriert ist. 503 hiesse: Konfiguration fehlt.
			return response.status === 302
		},
		120_000,
	)

	return child.pid
}

// --- Kommandos -------------------------------------------------------------

/**
 * Antwortet auf dem Port der Anwendung schon irgendetwas?
 *
 * Der Grund fuer diese Pruefung, an einem echten Vorfall gelernt: Nach einem
 * abgebrochenen Lauf lief die Anwendung des SCHWESTER-Repos noch und hielt
 * Port 4322. Der neue Lauf startete seine eigene daneben, die den Port nicht
 * mehr bekam — und alle Anfragen gingen an die alte, die gegen eine laengst
 * geloeschte ZITADEL-Instanz konfiguriert war. Ergebnis: sechzehn rote Tests
 * und kein Hinweis worauf. Lieber gar nicht erst starten.
 */
const portInUse = async () => {
	try {
		await fetch(appOrigin, {
			redirect: 'manual',
			signal: AbortSignal.timeout(2000),
		})
		return true
	} catch {
		return false
	}
}

const up = async () => {
	// `up` raeumt zuerst auf. Damit ist es beliebig oft wiederholbar, und ein
	// Rest vom letzten Lauf kann sich nicht in diesen hineinmischen.
	down({ quiet: true })

	if (await portInUse()) {
		throw new Error(
			`Auf ${appOrigin} antwortet bereits etwas, das dieser Lauf nicht gestartet hat.\n` +
				'Vermutlich laeuft die Anwendung eines abgebrochenen Laufs (auch aus einem\n' +
				'anderen Klassen-Repo) noch. Sie beenden, dann erneut versuchen — oder mit\n' +
				'AUTHZ_APP_PORT einen anderen Port waehlen.',
		)
	}

	const state = await setup()
	state.appPid = await buildAndStartApp(state)
	writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
	log(`bereit. Zustand in ${statePath}`)
}

const down = ({ quiet = false } = {}) => {
	if (existsSync(statePath)) {
		const state = JSON.parse(readFileSync(statePath, 'utf8'))
		if (state.appPid) {
			try {
				// Negative PID: die ganze Prozessgruppe. `npm start` startet einen
				// Kindprozess, und der haelt den Port sonst weiter.
				process.kill(-state.appPid, 'SIGTERM')
			} catch {
				// Schon tot — das ist das Ziel.
			}
		}
		rmSync(statePath, { force: true })
	}
	for (const name of Object.values(names)) {
		docker(['rm', '-f', name], { allowFailure: true })
	}
	if (!quiet) log('abgeraeumt')
}

const logs = () => {
	console.log('===== docker ps -a =====')
	console.log(
		docker(['ps', '-a', '--filter', 'name=fws-authz'], { allowFailure: true }),
	)
	for (const name of Object.values(names)) {
		console.log(`\n===== docker logs ${name} =====`)
		console.log(containerLogs(name))
	}
	console.log('\n===== Anwendung =====')
	if (existsSync(appLogPath)) console.log(readFileSync(appLogPath, 'utf8'))
}

const command = process.argv[2]
try {
	if (command === 'up') await up()
	else if (command === 'down') down()
	else if (command === 'logs') logs()
	else {
		console.error('Aufruf: stack.mjs up|down|logs')
		process.exit(2)
	}
} catch (error) {
	console.error(`[stack] ${error instanceof Error ? error.message : error}`)
	process.exit(1)
}
