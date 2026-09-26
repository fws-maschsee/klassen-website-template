# klassen-website-template

Copier-Vorlage für Klassen-Websites an einer Waldorfschule. Eine neue Klasse
hat damit in wenigen Minuten eine lauffähige, geschützte Website - mit
demselben Aufbau wie die beiden laufenden Instanzen, aus denen diese Vorlage
destilliert ist. Jene Repositories sind privat: dort stehen die Unterlagen und
Protokolle einer echten Elternschaft.

**Dieses Repository ist öffentlich.** Es enthält deshalb keine echten
Klassennamen, keine echte Schuldomain und keine Personendaten - überall stehen
Platzhalter nach RFC 2606 (`schule.example`, `example.org`). Wer hier etwas
ergänzt, hält das durch.

## Eine neue Klassenseite anlegen

Vorausgesetzt wird nur `uvx` ([uv](https://docs.astral.sh/uv/)).

```bash
uvx copier copy gh:fws-maschsee/klassen-website-template ./klasse-neu
```

Copier fragt nach Klassenname, Kurzname, Domain und den übrigen Werten (siehe
Tabelle unten) und schreibt das fertige Repository nach `./klasse-neu`.

```bash
cd klasse-neu
npm ci                # installiert aus der mitgelieferten Lockfile
npm run build         # muss durchlaufen, bevor irgendetwas gepusht wird
git init && git add -A && git commit -m "Website aus Vorlage erzeugt"
gh repo create <organisation>/klasse-neu --private --source=. --push
```

Danach die Dinge erledigen, die außerhalb des Repositories liegen - sie stehen
ausführlich in `deploy/README.md` der erzeugten Instanz:

1. **ZITADEL-Projekt für die Klasse anlegen**: Rollen `mitglied` und `admin`,
   einen OIDC-Client mit der redirect_uri `https://<domain>/auth/callback`, und
   die Grants der Eltern. Ohne das kommt niemand hinein.
2. **Die Secrets erzeugen.** Die beiden SealedSecrets unter
   `deploy/overlays/production/` kommen als **Gerüst** mit Platzhaltern - ein
   SealedSecret ist für genau einen Namespace und Cluster verschlüsselt und
   lässt sich nicht mitliefern. Die `kubeseal`-Kommandos stehen in
   `deploy/README.md`.
3. **DNS** auf den Cluster zeigen lassen (bei Wildcard-Eintrag: nichts zu tun).
4. **Argo-CD-`Application` im GitOps-Repository anlegen**, die auf den Branch
   `production` dieses neuen Repositories zeigt. Die Manifeste selbst bleiben
   im App-Repo.

**ZITADEL ist nicht Teil dieser Vorlage.** Projekt, Rollen, OIDC-Client und
Grants sind Identity-Content: Sie werden über die ZITADEL-API gepflegt und
stehen in keinem Repository - auch nicht hier. Die Vorlage fragt nur nach den
IDs, die die App zur Laufzeit braucht.

## Später Verbesserungen nachziehen

```bash
cd klasse-neu && uvx copier update
```

`.copier-answers.yml` in der Instanz merkt sich Vorlage, Version und Antworten.
`copier update` spielt genau die Änderungen ein, die seitdem hier passiert sind.
Konflikte werden wie bei einem Rebase gemeldet.

### Warum nicht der "Use this template"-Knopf von GitHub

Weil er die Dateien einmalig kopiert und **jede Verbindung kappt**. Wird hier
ein Fehler behoben - etwa eine Falle aus dem Abschnitt unten -, kommt die
Korrektur bei den bestehenden Klassen nie an; jede müsste sie einzeln
nachbauen. Genau dieser Update-Pfad ist der Grund für Copier. Das
Template-Flag darf auf dem Repository gesetzt sein (Auffindbarkeit), aber
erzeugt wird mit Copier.

### Warum nicht ein geteiltes npm-Paket oder ein Monorepo

Ein Monorepo würde die Klassen aneinanderketten: Ein Fehler in einer Klasse
blockiert das Deployment aller. Ein npm-Paket würde nur den Code teilen, nicht
die Dateien, um die es hier eigentlich geht (Dockerfile, Workflows, Manifeste,
README). Copier verteilt beides und lässt jede Klasse dennoch ihr eigenes Tempo
haben.

## Der Stack, den die Vorlage festhält

- **Astro 5** im SSR-Modus über `@astrojs/node` im Modus `middleware`; der
  Astro-Server hängt in einem Express-Prozess (`server.ts`), damit MCP-Endpunkt,
  OAuth-Routen und Queue-Worker daneben laufen können
- **Shipyard**: `@levino/shipyard-base`, `-docs`, `-blog`
- **Tailwind 3 + daisyUI 4**
- **Anmeldung** über OpenID Connect gegen ein zentrales ZITADEL; Zugang hat, wer
  im ZITADEL-**Projekt der Klasse** die Rolle `mitglied` hat
- **SQLite** (better-sqlite3) auf einem persistenten Volume, Schema über
  dbmate-Migrationen in `db/migrations/`
- **Adressbuch, Gruppen und Mailinglisten** samt Verwaltungsoberfläche unter
  `/verwaltung`
- **MCP-Server** unter `/mcp` mit eigenem OAuth-2.1-Server samt Dynamic Client
  Registration - damit lässt sich das Adressbuch im Gespräch pflegen
- **Cloudflare-Email-Worker** (`email-worker/`) als Eingang der Mailinglisten,
  Versand über Amazon SES
- Inhalte als Markdown unter `src/content/docs` und `src/content/blog`
- Docker-Image (dreistufig), Deployment auf k3s über Argo CD

SSR und nicht statisch, weil die Auth-Middleware jede Anfrage sehen muss. Ein
statischer Build würde alle Protokolle als öffentliche HTML-Dateien ausliefern.

### Was die Vorlage über Daten festlegt

Das Adressbuch speichert **nur Vorname, Nachname und E-Mail-Adresse** - dazu
intern die `zitadel_user_id` als stabile Verbindung zur Anmeldung, die die
Lesepfade bewusst nicht herausgeben. Keine Anrede, keine Telefonnummer, keine
Freitext-Notizen. Eine Vorlage, die eine
Anrede aus drei festen Werten vorschreibt, trifft eine Festlegung über
Menschen, die sie niemandem aufdrängen sollte; und jedes vorgegebene Feld ist
eines, das jede neue Klasse begründen müsste. Wer ein Feld braucht, ergänzt es
in seiner Klasse mit einer eigenen Migration.

Neue Mailinglisten stehen auf `poster_policy: offen` - jede Absenderadresse
darf schreiben. Das ist die bewusste Vorgabe: Ein Verteiler, der nur
Eingeweihte durchlässt, verliert genau die Post, auf die es ankommt, und der
Absender erfährt davon nur über eine Unzustellbarkeitsnachricht. Wer es enger
will, stellt eine Liste in der Verwaltung auf `eingeschraenkt` und hinterlegt
Muster (`anna@example.org` oder `*@schule.example` - die Domain muss exakt
stimmen, Subdomains zählen nicht). Die erzeugte README erklärt beides, damit
die Klasse die Entscheidung bewusst trifft.

## Die Fallen, die die Vorlage verhindert

Alle elf sind beim Aufbau und Betrieb der beiden Referenz-Instanzen wirklich
passiert. Eine Vorlage, die sie nicht verhindert, wäre wertlos.

### 1. Shipyard-Versionen sind gepinnt

`"@levino/shipyard-*": "*"` in `package.json` zieht Shipyard 0.8.x, das Astro 6
voraussetzt. Der Build bricht dann ab mit:

```
Rollup failed to resolve import "virtual:shipyard/css"
```

Die Vorlage pinnt exakt auf 0.6.1 / 0.6.1 / 0.6.2 und begründet das direkt in
`package.json`. Ein Wechsel auf Shipyard 0.8 ist ein bewusster Schritt zusammen
mit Astro 6 - hier in der Vorlage, dann per `copier update` bei allen Klassen.

### 2. `npm ci --omit=dev` in der Runner-Stufe, mit mitkopierter Lockfile

Mit `npm install` löst npm die Versionsbereiche im Image ein zweites Mal auf,
und das Image enthält etwas anderes als der geprüfte Build. Deshalb wird
`package-lock.json` in die Runner-Stufe mitkopiert und dort `npm ci --omit=dev`
ausgeführt.

Die Vorlage liefert eine fertige `package-lock.json` mit, damit `npm ci` schon
beim allerersten Build der neuen Klasse funktioniert.

### 3. `html-escaper` als Produktions-Abhängigkeit

Astro braucht `html-escaper@^3` zur Laufzeit, deklariert es aber nicht so, dass
es das Hoisting übersteht: Das dev-Paket `istanbul-reports` belegt die oberste
Ebene von `node_modules` mit `html-escaper@2`, Astro bekommt eine verschachtelte
Kopie - und die erreichen die SSR-Chunks unter `dist/` nicht. Solange
dev-Abhängigkeiten mitinstalliert sind, fällt das nicht auf. Unter `--omit=dev`
verschwindet die gehoistete Kopie und der Server stirbt beim Start mit
`ERR_MODULE_NOT_FOUND`.

Die Vorlage führt `html-escaper` deshalb explizit unter `dependencies`, obwohl
kein `import` darauf zeigt.

### 4. Smoke-Test vor dem Push ins Register

Der Deploy-Workflow der erzeugten Instanz baut das Image zuerst nur lokal
(`load: true`), startet es mit **denselben Einschränkungen wie der Cluster**
(`--user 1000:1000 --read-only --tmpfs /tmp`) und prüft, dass es antwortet. Erst
danach wird gepusht. Dieser Test hat die Punkte 1 und 2 gefangen, bevor sie im
Cluster landeten.

Beim Nachbauen aufpassen: `curl` gibt bei Verbindungsfehler bereits `000` aus.
Ein angehängtes `|| echo 000` erzeugt `000000` - und die Prüfung besteht dann
gegen einen toten Server. Im Workflow steht deshalb `|| true`.

Geprüft wird nur, **dass** eine HTTP-Antwort kommt, nicht welche: Die
Auth-Middleware antwortet unangemeldet mit 401, und das ist die gesunde
Produktionsantwort.

### 5. Ein Ort für alle Bezeichnungen

An Waldorfschulen wechselt die Klassenlehrkraft. Bei der ersten migrierten
Klasse steckte der Name in 19 Dateien. Die Vorlage legt `src/site.config.ts`
an, das Klassenname, Schulname, Domain, Repo-URL, Auth-Gruppe und Kalenderpfad
bündelt. Welcher Wert beim Wechsel mitwandert, steht in der `CLAUDE.md` der
Klasse.

### 6. Der Kalender-Dateiname wandert nie mit

Die Eltern haben `webcal://<domain>/public/<name>.ics` in ihrer Kalender-App
abonniert. Ändert sich diese Adresse, hören die Abos **still** auf zu
aktualisieren - niemand merkt es, bis Termine fehlen. Beim Wechsel der
Lehrkraft wird deshalb nur `X-WR-CALNAME` **in** der Datei geändert, nie ihr
Name.

Aus demselben Grund liegt die Datei unter `public/public/` und ist in
`src/middleware.ts` vom Login ausgenommen: Kalender-Apps schicken kein Cookie
mit.

### 7. Die Rolle gehört dem Identity-Provider, nicht diesem Repository

`AUTH_ROLE` in `src/site.config.ts` und `OIDC_REQUIRED_ROLE` im `Dockerfile`
müssen exakt einer Rolle im ZITADEL-**Projekt dieser Klasse** entsprechen. Wird
der Wert hier geändert, ohne die Rolle dort vorher anzulegen und die Grants
umzuhängen, findet die Prüfung niemanden mehr und **alle Eltern sind
ausgesperrt**. Die Reihenfolge ist bindend: erst ZITADEL, dann dieses
Repository.

Dass alle Klassen dieselbe Rolle `mitglied` benutzen, ist gefahrlos: ZITADEL
liefert im Token nur die Rollen **des Projekts, zu dem der OIDC-Client dieser
Seite gehört**. Die Trennung entsteht aus der Projektzuordnung, nicht aus dem
Namen.

### 8. Der Email-Worker wird nie von Hand ausgerollt

Kein `wrangler deploy`, kein `wrangler versions upload`, kein
`wrangler secret put`. Ein einzelner solcher Upload hat den Maileingang zweier
Klassen blockiert: Die hochgeladene Version verdrängte die aus `main` gebaute,
und eingehende Listenmail lief ins Leere. Ausgerollt wird ausschließlich über
die GitHub-Integration von Cloudflare aus `main`; das geteilte Secret wird
danach im Dashboard eingetragen.

### 9. Eine Instanz pro Klasse, und die Datei weiß es

Der Instanzname steht doppelt: als `MCP_INSTANCE_NAME` im Deployment und als
`app_meta.instance` **in der Datenbankdatei**, wohin er beim ersten Start
einmalig geschrieben wird. Weichen beide voneinander ab, fährt der Server gar
nicht erst hoch. Ohne diese Sperre wäre ein falsch gemountetes Volume ein
Versand von Elternpost in die falsche Klasse - ein Datenschutzvorfall, kein
Betriebsfehler.

### 10. Adressen von Verteilern stehen nie im Text

In einer der Referenzklassen standen die Verteiler-Adressen von Hand in den
Unterlagen. Die Anwendung stellte längst unter anderen Adressen zu; wer auf die
angegebene antwortete, schrieb ins Leere - monatelang, ohne dass es jemandem
auffiel. Eine Angabe, die an zwei Orten steht, veraltet an einem davon.

Die Vorlage liefert deshalb `/verteiler`: eine Übersicht, die zur Laufzeit aus
`mailing_lists` entsteht, mit der Adresse aus Localpart und `listDomain()`.
Dazu einen Test, der alle `.astro`/`.md`/`.mdx` unter `src/` nach
Verteiler-Adressen als Literal durchsucht und fehlschlägt, sobald eine
auftaucht. Für eine Vorlage ist dieser Test besonders wertvoll: Eine einmal
hineingeschriebene Adresse würde jede erzeugte Klasse mit erben.

### 11. Keine echten Personendaten, nirgends

Diese Vorlage ist ein **öffentliches** Repository. In `src/content/`, in
Beispieldaten, in Migrationen, in Test-Fixtures und in den Vorgabewerten von
`copier.yml` stehen ausschließlich erfundene Namen und Platzhalter-Domains nach
RFC 2606 (`schule.example`, `example.org`) - kein echter Klassenname, keine
echte Schuldomain, keine echte Kontaktadresse. Die SealedSecrets sind Gerüste
mit Platzhaltern; die CI prüft, dass sie es bleiben.

Aus demselben Grund bindet die Vorlage von sich aus **keinen fremden Host** in
die erzeugte Seite ein: `plausible_script_url` ist standardmäßig leer.

## Variablen

| Variable | Vorgabe | Wofür |
| --- | --- | --- |
| `class_display_name` | - | Anzeigename, z. B. "Klasse Musterfrau". Der einzige Wert, der beim Lehrkraftwechsel geändert wird. |
| `class_slug` | aus dem Anzeigenamen | Technischer Kurzname. Steckt in Repo-Name, Hostname, Auth-Gruppe, Kalenderdatei. |
| `school_name` | Freie Waldorfschule Musterstadt | Erscheint auf der Startseite. Platzhalter - ersetzen. |
| `first_post_date` | 2026-01-01 | Datum des Willkommens-Beitrags. Auf den heutigen Tag setzen. |
| `github_org` | meine-schule | Besitzer des erzeugten Repositories. Platzhalter - ersetzen. |
| `repo_name` | `klasse-<slug>` | Repository, Namespace, Image, Instanz-Identität, DB-Dateiname, Klassen-Label der Listen. Faktisch unveränderlich. |
| `base_domain` | schule.example | Basis-Domain; braucht `*.<domain>` im DNS. Platzhalter - ersetzen. |
| `site_domain` | `klasse-<slug>.<base_domain>` | Vollständiger Hostname. Nach dem Livegang faktisch festgenagelt. |
| `contact_email` | `technik@<base_domain>` | Technischer Kontakt in der README. |
| `oidc_issuer` | `https://id.<base_domain>` | Aussteller des zentralen ZITADEL. |
| `zitadel_org_id` | leer | ID der ZITADEL-Organisation. Für den Adressbuch-Abgleich. |
| `zitadel_project_id` | leer | ID des ZITADEL-Projekts **dieser Klasse**. |
| `mail_from` | `noreply@<base_domain>` | Verifizierte SES-Absenderadresse. |
| `list_base_domain` | `lists.<base_domain>` | Listen-Domain ohne Klassen-Label; braucht `*.<domain>` als MX. |
| `worker_name` | `<repo_name>` | Name des Cloudflare-Workers dieser Klasse. |
| `calendar_filename` | `<slug>.ics` | Dateiname des Kalenders. Danach unveränderlich. |
| `gitops_repo` | `<github_org>/server-config` | Wo die Argo-CD-`Application` liegt. |
| `target_arch` | amd64 | Architektur des Cluster-Knotens. Bestimmt den Runner. |
| `plausible_script_url` | leer | Besucherzählung. Leer (Vorgabe) = keine Statistik und kein fremder Host im `<head>`. |

### Was bewusst nicht variabel ist

Diese Dinge stehen fest, weil eine Wahlmöglichkeit hier nur Varianten erzeugen
würde, die niemand testet:

- **Astro 5 + `@astrojs/node` standalone, SSR.** Kein statischer Modus, kein
  anderer Adapter.
- **Shipyard 0.6.x, exakt gepinnt.** Siehe Falle 1.
- **Tailwind 3 + daisyUI 4.** Der Sprung auf Tailwind 4 kommt zusammen mit
  Shipyard 0.8 und Astro 6, für alle Klassen gleichzeitig.
- **Node 22 (alpine), Port 3000, Registry `ghcr.io`.**
- **Biome** als Formatter und Linter, Version an den Workflow gekoppelt.
- **Routen `/docs` und `/blog`**, Beschriftungen "Unterlagen" und "Berichte".
- **Deutsch** als Sprache des erzeugten Repositories.
- **Kubernetes-Manifeste im App-Repo**, unter `deploy/overlays/production/`.
  Im GitOps-Repo liegt nur die Argo-CD-`Application`. Ausgerollt wird über den
  Branch `production`, den der Deploy-Workflow schreibt - das Repository
  bekommt dadurch **keinen** Cluster-Zugriff.
- **Nur Name und E-Mail im Adressbuch.** Siehe oben.
- **ZITADEL** als Identity-Provider, ein Projekt pro Klasse.

## Aufbau dieses Repositories

```
copier.yml                Fragen, Vorgaben, Validierung
template/                 wird in die neue Klassenseite geschrieben
tests/answers-ci.yml      Antworten der CI-Instanz (nur Beispielwerte)
.github/workflows/ci.yml  erzeugen, bauen, testen, Image + Smoke-Test
CLAUDE.md                 Anleitung zum Ändern der Vorlage selbst
```

Dateien mit der Endung `.jinja` werden ersetzt, alle anderen wörtlich kopiert.
Auch Dateinamen können Variablen enthalten - `public/public/{{ calendar_filename }}.jinja`
wird zu `public/public/musterfrau.ics`.

## CI

Jeder Push prüft die ganze Kette:

1. **generate** - Instanz erzeugen, auf unersetzte Platzhalter prüfen, alle
   YAML-Dateien parsen, `kubectl kustomize deploy/overlays/production` bauen,
   prüfen, dass die SealedSecrets Platzhalter geblieben sind.
2. **build** - `npm ci`, `npm run build`, `astro check`, `npm test`, `biome ci`.
3. **email-worker** - `npm ci`, `npm run typecheck`, `npm test` im
   Worker-Projekt. Kein Deployment.
4. **e2e** - Playwright gegen die erzeugte Instanz.
5. **image** - Docker-Image bauen und mit den Cluster-Einschränkungen starten
   (`--user 1000:1000 --read-only --tmpfs /tmp --tmpfs /data`).
6. **update-roundtrip** - `copier update` von der Vorgänger-Revision muss
   konfliktfrei durchlaufen.

Bricht eine der Stufen, ist die Vorlage kaputt - und zwar bevor eine Klasse sie
benutzt.

## Etwas zurückgeben

Wird beim Betrieb einer Klasse etwas gelernt, das für alle gilt, gehört es als
Pull Request hierher. Absichtlich nicht automatisch: Nicht jeder lokale
Kunstgriff soll Kanon werden. Danach holen sich die anderen Klassen die
Änderung mit `copier update`.

Das Muster stammt aus
[levino/agentops-community-stack](https://github.com/levino/agentops-community-stack).
