# Emby Group Manager

Eigenständige Web-App (Docker) zur zentralen Verwaltung von Emby-Benutzern über die Emby-REST-API –
kein Emby-Plugin.

- **Bibliotheksgruppen & Kinderprofile**: Gruppen mit Bibliotheken, Altersfreigabe, Sperre für
  nicht bewertete Inhalte und gesperrten Tags. Mehrere Gruppen pro Benutzer, Rechte werden
  vereinigt, die strengste Altersfreigabe gilt. Vorschau (Diff) vor dem Anwenden.
- **Aperture**: jede Benutzerin/jeder Benutzer bekommt automatisch nur die eigenen
  „Für dich ausgewählt“-Bibliotheken, nie die der anderen.
- **Homescreen-Vorlagen**: Zeilen wie in Emby (Einstellungen › Startseite), Bibliotheksreihenfolge,
  ausgeblendete Bibliotheken, Startansichten, Aperture-Platzhalter, Kollektionszeilen,
  saisonale Zeilen und **Rotationsplätze** mit Pool, Gewichtung, Intervall und Vorschau.
- **Layout-Gruppen**: genau eine Vorlage je Gruppe, „Auf alle Mitglieder anwenden“ /
  „Alle überschreiben“ – immer mit Backup pro Benutzer, wiederherstellbar.
- **Abgleich** im Intervall: neue Benutzer, neue Aperture-Bibliotheken, fällige Rotationen,
  saisonale Kollektionen.
- **Dry-Run**, **Protokoll** aller Änderungen, **Diagnose** (Rohdaten-Snapshots vorher/nachher).

Getestet gegen Emby **4.10.2** (Startseite ab 4.10.0.4 nötig) und Aperture **v0.7.10**. Was genau
wie verifiziert wurde, steht in [docs/EMBY-API.md](docs/EMBY-API.md); Plan und Datenmodell in
[docs/PLAN.md](docs/PLAN.md).

## Installation

```yaml
# docker-compose.yml
services:
  emby-group-manager:
    image: ghcr.io/emrewest/emby-group-manager:latest
    container_name: emby-group-manager
    restart: unless-stopped
    ports:
      - "8099:8080"
    volumes:
      - ./data:/data
    environment:
      TZ: Europe/Berlin
      EMBY_URL: http://emby:8096
      EMBY_API_KEY: "…"
      APERTURE_URL: http://aperture:3456
      APERTURE_API_KEY: "apt_…"
```

```bash
docker compose up -d
```

Dann `http://SERVER-IP:8099` öffnen und mit einem **Emby-Administratorkonto** anmelden.

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `EMBY_URL` | ja | z. B. `http://emby:8096` (Dienstname im selben Docker-Netz) oder `http://192.168.1.10:8096` |
| `EMBY_API_KEY` | ja | Emby › Dashboard › Erweitert › API-Schlüssel |
| `APERTURE_URL` | empfohlen | z. B. `http://aperture:3456` |
| `APERTURE_API_KEY` | empfohlen | Aperture › Einstellungen › System › API Keys (Admin-Schlüssel, beginnt mit `apt_`) |
| `APERTURE_DB_URL` | optional | `postgres://user:pw@host:5432/aperture`, nur lesend; wird nur genutzt, wenn die API nicht antwortet |
| `SYNC_INTERVAL_MINUTES` | nein | Startwert für das Abgleichintervall (Standard 60, später in der Oberfläche änderbar) |
| `ADMIN_PASSWORD` | nein | zusätzlicher lokaler Login (`ADMIN_USER`, Standard `admin`), z. B. falls Emby nicht erreichbar ist |
| `DRY_RUN` | nein | `true` = Startwert Dry-Run |
| `TZ` | empfohlen | Zeitzone für Rotationszeiten |
| `SECURE_COOKIES` | nein | `true`, wenn die App nur über HTTPS erreichbar ist |

Daten (Gruppen, Vorlagen, Backups, Protokoll) liegen in `./data/app.db`. Diesen Ordner sichern.

**Wichtig:** In Ultimate Collections die eigene Startseiten-Funktion ausgeschaltet lassen – nur
dieses Tool schreibt Startseiten.

## Erste Schritte (empfohlene Reihenfolge)

1. **Einstellungen › Dry-Run einschalten.** Alles wird dann nur protokolliert.
2. **Bibliotheken & Aperture** prüfen: Hat jede „Für dich ausgewählt …“-Bibliothek den richtigen
   Besitzer? Rote Einträge werden nie freigegeben.
3. Bibliotheksgruppen anlegen, **Vorschau** ansehen, anwenden (im Dry-Run → Protokoll prüfen).
4. Dry-Run aus, erneut anwenden.
5. Vorlage anlegen (oder „Aus Benutzer übernehmen“), Layout-Gruppe anlegen, erst an einem
   Testbenutzer anwenden.

## Testen nach Meilenstein

### M1 – Verbindung, Benutzer- und Bibliotheksübersicht
1. Container starten, anmelden (Emby-Admin). Ein Nicht-Admin-Konto muss abgelehnt werden.
2. **Übersicht**: Emby-Version und Servername sichtbar, Aperture-Version und „API: ok (n
   Bibliotheken)“. Warnungen oben lesen.
3. **Bibliotheken & Aperture**: jede Aperture-Bibliothek mit Besitzer und Methode (erwartet:
   „Aperture-API“). Unter „Namensschema“ dein Muster eintragen und **Muster testen** – die echte
   Schreibweise deiner Bibliotheken muss erkannt werden.
4. **Benutzer**: Liste mit Hinweisen, z. B. wer fremde Aperture-Bibliotheken sieht.

### M2 – Bibliotheksgruppen, Aperture und Altersfreigaben
1. Gruppe „Familie“ (Filme, Serien) und Gruppe „Kinder“ (Kinderfilme, FSK 6, Kinderprofil,
   nicht bewertete blockieren) anlegen; ein Testkind in beide Gruppen.
2. **Vorschau & Anwenden**: Das Kind bekommt Filme + Serien + Kinderfilme + **nur seine**
   Aperture-Bibliotheken, Altersfreigabe FSK 6 (strengste). In Emby › Benutzer › Zugriff prüfen.
3. In Emby einen anderen Policy-Wert des Kindes merken (z. B. Remote-Zugriff) – er muss nach dem
   Anwenden unverändert sein.
4. In der Benutzerliste ist das Kind als **Kinderprofil** markiert.
5. Erneute Vorschau: „Keine Änderungen nötig“.

### M3 – Homescreen-Vorlagen, Layout-Gruppen, Kollektionszeilen
1. **Diagnose**: Snapshot „vorher“ vom Testbenutzer.
2. Vorlage mit: Weiterschauen, Aperture-Filme, Rotationsplatz (Sortierung „Zufällig“),
   Kollektion, saisonale Zeile, Neu hinzugefügt. Rotation an, Pool mit 3–4 Kollektionen.
3. **Vorschau** rechts für Heute / Morgen / Nächste Woche und für den Testbenutzer.
4. Layout-Gruppe mit dem Testbenutzer → **Vorschau** → **Auf alle Mitglieder anwenden**.
5. Als Testbenutzer in Emby anmelden: Zeilen, Reihenfolge, Aperture-Zeile mit seinem Namen.
   Startseite zweimal neu laden – die „Zufällig“-Zeile mischt neu.
6. **Diagnose**: Snapshot „nachher“, vergleichen. So siehst du genau, was in Emby gespeichert
   wurde (`homeSections[n].SortBy = "Random"` usw.).
7. Gegenprobe des Speicherformats: in der Emby-Oberfläche als dieser Benutzer eine Zeile ändern,
   Snapshot, vergleichen.

### M4 – Abgleich, Backup und Feinschliff
1. **Backups**: Für den Testbenutzer gibt es ein „Original“-Backup. **Wiederherstellen** → alte
   Startseite ist zurück.
2. **Einstellungen**: Standard-Bibliotheks- und Layout-Gruppe setzen. In Emby einen neuen Benutzer
   anlegen, **Übersicht › Jetzt abgleichen** → er ist in beiden Gruppen, hat Rechte und
   Startseite.
3. Vorlage › **Jetzt neu würfeln** → Ergebnisdialog, Verlauf im Tab „Rotation & Saison“.
4. **Protokoll**: jede Aktion ist da; mit Dry-Run zusätzlich als „Dry-Run“ markiert.

## Bekannte Grenzen / bitte am Testbenutzer prüfen

- **„Zufällig“ bei Kollektionszeilen**: Die Emby-Oberfläche bietet es dort nicht an. Die App
  schreibt `SortBy: Random` trotzdem; ob Emby die Zeile dann mischt, mit Schritt 5/6 von M3
  prüfen. Für Bibliotheks-/Typzeilen (z. B. Aperture-Zeile) ist es offiziell unterstützt.
- **Benutzer ohne gespeicherte Startseite** zeigen Embys Standardzeilen. Ein „Original“-Backup
  davon stellt diese Zeilen als normale, gespeicherte Zeilen wieder her.
- Alle Aussagen zum Speicherformat stammen aus dem Emby-4.10.2-Code (siehe
  [docs/EMBY-API.md](docs/EMBY-API.md)), nicht aus einem Live-Test – die Diagnose-Seite ist dafür
  da, sie auf deinem Server zu bestätigen.

## Entwicklung

```bash
npm install
npm test                 # Unit- und Ende-zu-Ende-Tests gegen einen Emby-Mock
EMBY_URL=… EMBY_API_KEY=… npm run dev
```

Das Image wird per GitHub Actions gebaut: `main` → `:latest`, Tag `v1.2.3` → `:1.2.3` und `:1.2`
(amd64 und arm64).
