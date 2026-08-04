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

## Die Lockfile

`template/package-lock.json` wird mitgeliefert, damit `npm ci` in der neuen
Klasse sofort funktioniert und das Docker-Image reproduzierbar ist.

Nach jeder Änderung an `template/package.json` muss sie neu erzeugt werden:

```bash
# Instanz erzeugen, dort npm install laufen lassen, Lockfile zurückkopieren
cd /tmp/instanz && npm install
cp package-lock.json <vorlage>/template/package-lock.json
```

Der Paketname ist absichtlich generisch (`klassen-website`) und nicht der
Klassenname - sonst müsste die Lockfile eine `.jinja`-Datei sein, und ein
Lehrkraftwechsel würde sie anfassen.

`_skip_if_exists` in `copier.yml` schützt die Lockfile der Instanz vor
`copier update`: Dort haben Dependabot und lokale Installationen längst neuere
Auflösungen eingetragen.

## Referenzen

Die Vorlage ist aus zwei laufenden Instanzen destilliert. Bei Zweifeln dort
nachsehen, wie es wirklich läuft:

- [`fws-maschsee/klasse-christophers`](https://github.com/fws-maschsee/klasse-christophers)
  - produktiv, Quelle für Dockerfile, Deploy-Workflow und Smoke-Test
- [`fws-maschsee/klasse-wiesen`](https://github.com/fws-maschsee/klasse-wiesen)
  - Quelle für `src/site.config.ts`, Admonitions und die Eltern-README
- [`levino/agentops-community-stack`](https://github.com/levino/agentops-community-stack)
  - das Copier-Muster selbst (README §6 und §8)
- [`fws-maschsee/server-config`](https://github.com/fws-maschsee/server-config)
  - das GitOps-Repository, in das `deploy/` kopiert wird

Die sieben Fallen, die die Vorlage abfängt, stehen mit Begründung in der
[README](README.md). Wer eine davon "aufräumt", baut einen Ausfall nach, den es
schon einmal gab.
