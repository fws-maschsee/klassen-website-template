# Arbeiten an dieser Vorlage

Diese Datei richtet sich an Agenten und Entwickler:innen, die **die Vorlage
selbst** ändern. Wer eine Klassenseite betreibt, liest die `CLAUDE.md` der
erzeugten Instanz.

## Sprache

Deutsch - in Commit-Nachrichten, Dokumentation und Antworten. Die erzeugten
Repositories werden von Eltern gelesen.

## Minimal comments policy
„Comments are apologies.“ Guter Code, sprechende Namen und Tests erklären sich selbst — normalerweise kein Kommentar.
Wo Code unerwartet ist (ungewöhnliche Wahl, Workaround, Einschränkung von außen, bewusst gegen die naheliegende Lösung), ist ein kurzer Warum-Kommentar Pflicht. Kein Was, keine Fehlergeschichte, keine Docstrings, kein auskommentierter Code. Werkzeug-Direktiven bleiben.

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
Alternative erwähnenswert ist, kommt in die Dokumentation ein kurzer Absatz
"Warum nicht X" - keine zwei gleichwertigen Wege.

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
  Beispieldaten, nicht in Migrationen, nicht in Test-Fixtures. Erfundene Namen
  und `example.org`-Adressen (RFC 2606).
- **Keine Secrets.** Die SealedSecrets unter
  `template/deploy/overlays/production/` sind **Gerüste** mit dem Platzhalter
  `PLATZHALTER-MIT-KUBESEAL-ERSETZEN`; die CI prüft, dass das so bleibt. Ein
  SealedSecret ist ohnehin für genau einen Namespace und Cluster
  verschlüsselt - das Chiffrat einer Klasse ist anderswo wertlos.
- **Keine Namen realer Klassen** als Beispielwerte. In Tests stehen
  `klasse-musterfrau` und `klasse-nachbar`.

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
nachsehen, wie es wirklich läuft — **beide Repositories sind privat und werden
hier bewusst nicht beim Namen genannt**: dieses Repository ist öffentlich, und
der Name einer Klasse ist eine Angabe über echte Familien.

- die **erste Instanz** ist die Hauptquelle dieser Vorlage: Anmeldung,
  Datenbank, MCP-Server, Mailinglisten, Produktions-Overlay
- die **zweite Instanz** unterscheidet sich von der ersten genau in den
  Werten, aus denen hier Platzhalter geworden sind
- das **GitOps-Repository** der Schule, in das die Argo-CD-`Application`
  kommt, während `deploy/` im App-Repo bleibt
- [`levino/agentops-community-stack`](https://github.com/levino/agentops-community-stack)
  - das Copier-Muster selbst (README §6 und §8)

Diese Trennung ist keine Förmlichkeit: Wer hier einen Repository-Namen,
eine Klassenbezeichnung oder die Schuldomain einträgt, veröffentlicht sie.

Die elf Fallen, die die Vorlage abfängt, stehen mit Begründung in der
[README](README.md). Wer eine davon "aufräumt", baut einen Ausfall nach, den es
schon einmal gab.
