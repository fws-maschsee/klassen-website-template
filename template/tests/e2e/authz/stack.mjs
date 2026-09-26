#!/usr/bin/env node

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

const workDir = resolve(here, '.stack')
const statePath = resolve(workDir, 'stack.json')
const appLogPath = resolve(workDir, 'app.log')
const patDir = resolve(workDir, 'pat')

// Dieselben Versionen wie im Betrieb: eine andere ZITADEL-Version prüft anderes Verhalten.
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

// Hartkodiert zulässig: er verschlüsselt nur eine Wegwerf-Instanz, die jeder Lauf löscht.
const MASTERKEY = 'MasterkeyNeedsToHave32Characters'

const OWN_PROJECT = 'klasse-musterfrau'
const OTHER_PROJECT = 'klasse-nachbar'

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

const containerLogs = (name) => {
	const result = spawnSync('docker', ['logs', '--tail', '200', name], {
		encoding: 'utf8',
	})
	// Beide Ströme: ZITADEL und PostgreSQL loggen nach stderr.
	return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

const isRunning = (name) =>
	docker(['inspect', '-f', '{{.State.Running}}', name], {
		allowFailure: true,
	}) === 'true'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

class AbortSetup extends Error {}

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
		'--tmpfs',
		'/var/lib/postgresql/data',
		POSTGRES_IMAGE,
	])
	return waitFor(
		'postgres',
		() =>
			spawnSync(
				'docker',
				[
					'exec',
					names.postgres,
					// Über TCP: der vorläufige Init-Server des Images lauscht nur am Socket und meldet sonst zu früh bereit.
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
	// ZITADEL schreibt das PAT unter eigener UID; auf dem CI-Runner gehört das Verzeichnis einer anderen.
	chmodSync(patDir, 0o777)
	docker([
		'run',
		'-d',
		'--name',
		names.zitadel,
		'--network',
		network,
		'-p',
		`${ports.zitadel}:${ports.zitadel}`,
		'-p',
		`${ports.login}:${ports.login}`, // Login v2 teilt sich den Netzwerk-Namensraum dieses Containers
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
		'ZITADEL_FIRSTINSTANCE_ORG_NAME=klassenseite-e2e',
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME=e2e-root',
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORD=Password1!',
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_HUMAN_PASSWORDCHANGEREQUIRED=false',
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME=e2e-admin-sa',
		'-e',
		'ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_NAME=E2E Admin',
		// Ohne Ablaufdatum legt ZITADEL gar kein PAT an, und der Aufbau wartet ewig auf die Datei.
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
		if (!isRunning(names.zitadel)) {
			throw new AbortSetup(
				`Der ZITADEL-Container ist beendet. Sein Log:\n${containerLogs(names.zitadel)}`,
			)
		}
		const response = await fetch(`${issuer}/debug/ready`)
		return response.status === 200 && existsSync(resolve(patDir, 'admin.pat'))
	})
	const adminToken = readFileSync(resolve(patDir, 'admin.pat'), 'utf8').trim()

	// /debug/ready meldet schon 200, während die Verwaltungs-API intern noch „connection refused“ liefert.
	await waitFor('zitadel (verwaltungs-api)', async () => {
		const response = await fetch(`${issuer}/management/v1/orgs/me`, {
			headers: { Authorization: `Bearer ${adminToken}` },
		})
		return response.status === 200
	})

	return adminToken
}

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
		`container:${names.zitadel}`, // ZITADEL antwortet nur unter localhost; so ist die Adresse für Login, Browser und App dieselbe
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

// Nur Kennung und Kennwort: sonst schiebt Login v2 eine versionsabhängige MFA-/Passkey-Seite in jede Anmeldung.
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
		passwordCheckLifetime: '864000s',
		externalLoginCheckLifetime: '864000s',
		mfaInitSkipLifetime: '0s',
		secondFactorCheckLifetime: '864000s',
		multiFactorCheckLifetime: '864000s',
	})

const createProject = async (adminToken, name) => {
	const project = await api(adminToken, 'POST', '/management/v1/projects', {
		name,
		projectRoleAssertion: true, // nur damit stehen die Projektrollen im Token
		projectRoleCheck: false, // sonst wiese ZITADEL selbst ab, und die Seite „nicht freigeschaltet“ bliebe ungeprüft
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
			'OIDC_GRANT_TYPE_REFRESH_TOKEN', // ohne Refresh keine Nachprüfung, also kein wirksamer Entzug
		],
		appType: 'OIDC_APP_TYPE_WEB',
		authMethodType: 'OIDC_AUTH_METHOD_TYPE_BASIC',
		accessTokenType: 'OIDC_TOKEN_TYPE_BEARER',
		accessTokenRoleAssertion: true,
		idTokenRoleAssertion: true,
		idTokenUserinfoAssertion: true,
		devMode: true,
	})

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
		roles: ['ORG_USER_MANAGER'], // nicht ORG_OWNER: eine zu schwache Betriebsrolle soll hier auffallen
	})
	return pat.token
}

const TEST_PASSWORD = 'E2e-Testpasswort-1!'

const createUser = async (adminToken, key, firstName, lastName) => {
	const email = `e2e-${key}@example.invalid` // RFC 2606: garantiert nicht zustellbar
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
	const ownProjectId = await createProject(adminToken, OWN_PROJECT)
	const otherProjectId = await createProject(adminToken, OTHER_PROJECT)
	const client = await createOidcClient(adminToken, ownProjectId)

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

	const fremd = await createUser(adminToken, 'fremd', 'Frieda', 'Feldmann')
	fremd.grantId = await grant(adminToken, fremd.userId, otherProjectId, [
		'mitglied',
	])
	users.fremd = fremd

	// Eigene Nutzer je Test: die Tests ändern Rollen und hingen sonst von der Reihenfolge ab.
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

const appEnv = (state) => ({
	...process.env,
	NODE_ENV: 'production',
	DISABLE_AUTH: '', // diese Tests prüfen die Anmeldung selbst
	PORT: String(ports.app),
	OIDC_ISSUER: state.issuer,
	OIDC_CLIENT_ID: state.clientId,
	OIDC_CLIENT_SECRET: state.clientSecret,
	OIDC_REQUIRED_ROLE: 'mitglied',
	SESSION_SECRET: state.sessionSecret,
	OIDC_PUBLIC_ORIGIN: appOrigin,
	PUBLIC_BASE_URL: appOrigin,
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
			return response.status === 302
		},
		120_000,
	)

	return child.pid
}

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
				process.kill(-state.appPid, 'SIGTERM') // ganze Prozessgruppe, sonst hält der Kindprozess von npm start den Port
			} catch {
				// schon beendet
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
