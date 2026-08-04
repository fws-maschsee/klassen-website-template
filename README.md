# klassen-website-template

Copier-Vorlage für die Klassen-Websites der Freien Waldorfschule
Hannover-Maschsee. Eine neue Klasse hat damit in wenigen Minuten eine
lauffähige, geschützte Website - mit demselben Aufbau wie
[`klasse-christophers`](https://github.com/fws-maschsee/klasse-christophers) und
[`klasse-wiesen`](https://github.com/fws-maschsee/klasse-wiesen), aus denen
diese Vorlage destilliert ist.

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
gh repo create fws-maschsee/klasse-neu --private --source=. --push
```

Danach die drei Dinge erledigen, die außerhalb des Repositories liegen - sie
stehen ausführlich in `deploy/README.md` der erzeugten Instanz:

1. **Benutzergruppe im Auth-Backend anlegen** und die Eltern eintragen. Ohne sie
   antwortet die Seite jedem mit 401.
2. **DNS** auf den Cluster zeigen lassen (bei Wildcard-Eintrag: nichts zu tun).
3. **`deploy/` ins GitOps-Repository kopieren** und dort verdrahten.

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

- **Astro 5** im SSR-Modus über `@astrojs/node` (`mode: 'standalone'`)
- **Shipyard**: `@levino/shipyard-base`, `-docs`, `-blog`
- **Tailwind 3 + daisyUI 4**
- **Auth** über `@levino/pocketbase-auth`, Gruppenprüfung gegen PocketBase
- Inhalte als Markdown unter `src/content/docs` und `src/content/blog`
- Docker-Image (zweistufig), Deployment auf k3s über Argo CD

SSR und nicht statisch, weil die Auth-Middleware jede Anfrage sehen muss. Ein
statischer Build würde alle Protokolle als öffentliche HTML-Dateien ausliefern.

## Die Fallen, die die Vorlage verhindert

Alle sieben sind beim Aufbau der beiden Referenz-Instanzen wirklich passiert.
Eine Vorlage, die sie nicht verhindert, wäre wertlos.

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
bündelt - jeder Wert mit der Begründung, ob er beim Wechsel mitwandert oder
nicht.

### 6. Der Kalender-Dateiname wandert nie mit

Die Eltern haben `webcal://<domain>/public/<name>.ics` in ihrer Kalender-App
abonniert. Ändert sich diese Adresse, hören die Abos **still** auf zu
aktualisieren - niemand merkt es, bis Termine fehlen. Beim Wechsel der
Lehrkraft wird deshalb nur `X-WR-CALNAME` **in** der Datei geändert, nie ihr
Name.

Aus demselben Grund liegt die Datei unter `public/public/` und ist in
`src/middleware.ts` vom Login ausgenommen: Kalender-Apps schicken kein Cookie
mit.

### 7. Die Auth-Gruppe gehört dem Backend, nicht diesem Repository

`groupField` in `src/middleware.ts` muss exakt dem Gruppennamen in PocketBase
entsprechen. Wird er hier geändert, ohne die Gruppe dort vorher umzubenennen,
findet die Prüfung niemanden mehr und **alle Eltern sind ausgesperrt**. Die
Reihenfolge ist bindend: erst PocketBase, dann `AUTH_GROUP` in
`src/site.config.ts` und `AUTH_POCKETBASE_GROUP` im `Dockerfile`.

## Variablen

| Variable | Vorgabe | Wofür |
| --- | --- | --- |
| `class_display_name` | - | Anzeigename, z. B. "Klasse Wiesen". Der einzige Wert, der beim Lehrkraftwechsel geändert wird. |
| `class_slug` | aus dem Anzeigenamen | Technischer Kurzname. Steckt in Repo-Name, Hostname, Auth-Gruppe, Kalenderdatei. |
| `school_name` | Freie Waldorfschule Hannover-Maschsee | Erscheint auf der Startseite. |
| `first_post_date` | 2026-01-01 | Datum des Willkommens-Beitrags. Auf den heutigen Tag setzen. |
| `github_org` | fws-maschsee | Besitzer des erzeugten Repositories. |
| `repo_name` | `klasse-<slug>` | Repository- und Namespace-Name, Image-Name. |
| `base_domain` | fws-maschsee-test.de | Basis-Domain; braucht `*.<domain>` im DNS. |
| `site_domain` | `klasse-<slug>.<base_domain>` | Vollständiger Hostname. Nach dem Livegang faktisch festgenagelt. |
| `contact_email` | post@levinkeller.de | Technischer Kontakt in der README. |
| `mailing_list` | `eltern-klasse-<slug>@googlegroups.com` | Elternverteiler. Leer = Abschnitt entfällt. |
| `auth_pocketbase_url` | https://api.levinkeller.de | Auth-Backend. |
| `auth_group` | `<slug>` | Gruppenname im Auth-Backend. Muss dort exakt so existieren. |
| `calendar_filename` | `<slug>.ics` | Dateiname des Kalenders. Danach unveränderlich. |
| `gitops_repo` | fws-maschsee/server-config | Wohin der Image-Tag eingetragen wird. |
| `target_arch` | amd64 | Architektur des Cluster-Knotens. Bestimmt den Runner. |
| `plausible_script_url` | analytics.levinkeller.de | Besucherzählung. Leer = keine Statistik. |

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
- **Kubernetes-Manifeste im GitOps-Repo**, nicht in der Klasse. Sonst bräuchte
  ein von Eltern bearbeitetes Repository ein Token mit Cluster-Schreibrecht.

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
wird zu `public/public/wiesen.ics`.

## CI

Jeder Push prüft die ganze Kette:

1. **generate** - Instanz erzeugen, auf unersetzte Platzhalter prüfen, alle
   YAML-Dateien parsen, `kubectl kustomize deploy/` bauen.
2. **build** - `npm ci`, `npm run build`, `astro check`, `biome ci`.
3. **e2e** - Playwright gegen die erzeugte Instanz.
4. **image** - Docker-Image bauen und mit den Cluster-Einschränkungen starten.
5. **update-roundtrip** - `copier update` von der Vorgänger-Revision muss
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
