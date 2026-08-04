# Arbeiten an dieser Vorlage

Diese Datei richtet sich an Agenten und Entwickler:innen, die **die Vorlage
selbst** ändern. Wer eine Klassenseite betreibt, liest die `CLAUDE.md` der
erzeugten Instanz.

## Sprache

Deutsch - in Kommentaren, Commit-Nachrichten und Antworten. Die erzeugten
Repositories werden von Eltern gelesen.

## Was hier wo liegt

```
copier.yml                Fragen, Vorgaben, Validierung
template/                 alles hier drin landet in der erzeugten Klassenseite
tests/answers-ci.yml      Antworten der CI-Instanz (nur RFC-2606-Beispielwerte)
.github/workflows/ci.yml  die einzige Prüfinstanz
```

`.jinja` am Ende = Datei wird gerendert. Ohne `.jinja` = wörtlich kopiert.
Dateinamen werden immer gerendert, auch ohne Endung.

## Regeln

**Jede Änderung an `template/` muss durch die CI.** Eine Vorlage, deren Ausgabe
nicht baut, ist schlimmer als keine. Lokal prüfen:

```bash
uvx --from 'copier>=9.4' copier copy --defaults \
  --data-file tests/answers-ci.yml --vcs-ref HEAD . /tmp/instanz
cd /tmp/instanz && npm ci && npm run build
```

**Vorschreiben, nicht anbieten.** Die Vorlage trifft die Entscheidung. Wo eine
Alternative erwähnenswert ist, kommt ein kurzer Absatz "Warum nicht X" mit
Begründung - keine zwei gleichwertigen Wege.

**Begründungen gehören neben den Wert, nicht in ein separates Dokument.** Wer
`AUTH_GROUP` ändert, liest `src/site.config.ts`, nicht die README. Deshalb steht
die Warnung dort.

**Neue Frage in `copier.yml` = neue Zeile in `tests/answers-ci.yml`.** Sonst
fällt sie in der CI auf die Vorgabe zurück und wird nie geprüft.

**`.jinja`-Dateien mit GitHub-Actions-Syntax brauchen `{% raw %}`.** `${{ ... }}`
enthält `{{`, das Jinja sonst als eigene Variable auswertet und zu einem leeren
String rendert. `template/.github/workflows/deploy.yml.jinja` zeigt, wie die
Raw-Blöcke gesetzt werden. Die anderen Workflows sind bewusst **keine**
`.jinja`-Dateien - sie brauchen keine Variablen und werden dadurch nicht
angefasst.

## Was NIE in dieses Repository kommt

Es ist **öffentlich**. Deshalb, ohne Ausnahme:

- **Keine echten Personendaten.** Nicht in `template/src/content/`, nicht in
  Beispieldaten, nicht in Migrationen, nicht in Test-Fixtures, nicht in
  Kommentaren. Erfundene Namen und `example.org`-Adressen (RFC 2606).
- **Keine Secrets.** Die SealedSecrets unter
  `template/deploy/overlays/production/` sind **Gerüste** mit dem Platzhalter
  `PLATZHALTER-MIT-KUBESEAL-ERSETZEN`; die CI prüft, dass das so bleibt. Ein
  SealedSecret ist ohnehin für genau einen Namespace und Cluster
  verschlüsselt - das Chiffrat einer Klasse ist anderswo wertlos.
- **Keine Namen realer Klassen** als Beispielwerte. In Tests und Kommentaren
  stehen `klasse-musterfrau` und `klasse-nachbar`.

## Was hier NICHT abgebildet wird

**ZITADEL.** Projekt, Rollen, OIDC-Client und die Grants der Eltern sind
Identity-Content: Sie werden über die ZITADEL-API gepflegt und stehen in
keinem Repository. Die Vorlage fragt nur nach `oidc_issuer`,
`zitadel_org_id` und `zitadel_project_id` - den Bezeichnern, die die App zur
Laufzeit braucht - und `template/deploy/README.md.jinja` beschreibt, was
außerhalb angelegt werden muss.

**Das Ausrollen des Email-Workers.** Er wird ausschließlich über die
GitHub-Integration von Cloudflare aus `main` gebaut. Kein `wrangler deploy`,
kein `wrangler versions upload`, kein `wrangler secret put` - auch nicht zum
Ausprobieren.

## Die Lockfiles

`template/package-lock.json` und `template/email-worker/package-lock.json`
werden mitgeliefert, damit `npm ci` in der neuen Klasse sofort funktioniert und
das Docker-Image reproduzierbar ist.

Nach jeder Änderung an `template/package.json` muss sie neu erzeugt werden:

```bash
# Instanz erzeugen, dort npm install laufen lassen, Lockfile zurückkopieren
cd /tmp/instanz && npm install
cp package-lock.json <vorlage>/template/package-lock.json
```

Der Paketname ist absichtlich generisch (`klassen-website` bzw.
`klassen-website-email-worker`) und nicht der Klassenname - sonst müssten die
Lockfiles `.jinja`-Dateien sein, und ein Lehrkraftwechsel würde sie anfassen.

`_skip_if_exists` in `copier.yml` schützt die Lockfiles der Instanz vor
`copier update`: Dort haben Dependabot und lokale Installationen längst neuere
Auflösungen eingetragen. Dieselbe Liste schützt
`deploy/overlays/production/kustomization.yaml` (trägt den gepinnten Image-Tag
des laufenden Deployments) und die beiden SealedSecrets - ein `copier update`
würde sonst eine laufende Klasse auf Platzhalter zurücksetzen.

## Referenzen

Die Vorlage ist aus zwei laufenden Instanzen destilliert. Bei Zweifeln dort
nachsehen, wie es wirklich läuft:

- [`fws-maschsee/klasse-wiesen`](https://github.com/fws-maschsee/klasse-wiesen)
  - der vollständigere Stand und die Hauptquelle dieser Vorlage: Anmeldung,
    Datenbank, MCP-Server, Mailinglisten, Produktions-Overlay
- [`fws-maschsee/klasse-christophers`](https://github.com/fws-maschsee/klasse-christophers)
  - die zweite laufende Instanz; die Unterschiede zu `klasse-wiesen` sind
    genau die Werte, aus denen hier Platzhalter geworden sind
- [`levino/agentops-community-stack`](https://github.com/levino/agentops-community-stack)
  - das Copier-Muster selbst (README §6 und §8)
- [`fws-maschsee/server-config`](https://github.com/fws-maschsee/server-config)
  - das GitOps-Repository, in das `deploy/` kopiert wird

Die elf Fallen, die die Vorlage abfängt, stehen mit Begründung in der
[README](README.md). Wer eine davon "aufräumt", baut einen Ausfall nach, den es
schon einmal gab.
