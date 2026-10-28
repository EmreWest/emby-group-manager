# Plan, Datenmodell und Entscheidungen

## Architektur

- **Node.js 24**, ein Prozess, keine Build-Stufe. Backend: `node:http` mit kleinem Router,
  Datenhaltung in **SQLite** über das eingebaute `node:sqlite` (`/data/app.db`). Einzige
  Abhängigkeit: `pg` für den optionalen, nur lesenden Zugriff auf die Aperture-Datenbank.
- **Frontend**: eine statische Seite (`public/`), Vanilla-JS, deutsche Oberfläche.
- **Emby** wird ausschließlich über die REST-API angesprochen (kein Plugin). Aperture wird nie
  verändert.

## Aperture-Zuordnung (gewählte Methode)

Pro Emby-Bibliothek gewinnt die erste Methode, die einen Besitzer liefert:

1. **Aperture-API** (empfohlen): `GET /api/users` + `GET /api/settings/strm-libraries` mit einem
   Admin-API-Key. Liefert Emby-Benutzer-Id und Emby-Bibliotheks-Id direkt – exakt die Zuordnung,
   die Aperture selbst verwendet.
2. **Aperture-Datenbank** (nur wenn die API nicht erreichbar ist): `strm_libraries JOIN users` in
   einer `READ ONLY`-Transaktion.
3. **Ordnerpfad**: Aperture schreibt nach `…/aperture/<Name>_<EmbyUserId>` bzw. `…/aperture-tv/…`;
   die Id am Ende ist die Emby-Benutzer-Id. Sehr zuverlässig, auch ohne API.
4. **Namensschema** als Fallback, z. B. `Für dich ausgewählt {username} {type}`, Groß-/Klein-
   schreibung egal, Leer- und Trennzeichen austauschbar. In der Oberfläche einstell- und testbar.

Bibliotheken, die als Aperture erkannt werden, aber keinem Benutzer zugeordnet werden können,
werden **nie** freigegeben und als Warnung angezeigt.

## Datenmodell (SQLite)

| Tabelle | Inhalt |
|---|---|
| `settings` | Laufzeit-Einstellungen (Dry-Run, Intervall, Namensschema, Standardgruppen, …) als JSON |
| `sessions` | Anmeldungen (Cookie `egm_session`) |
| `library_groups` | Name, Beschreibung, `is_kids`, `max_parental_rating`, `block_unrated` (JSON-Liste), `blocked_tags` (JSON) |
| `library_group_users` / `library_group_libraries` | Mitglieder (Emby-User-Id) / Bibliotheken (Emby-Guid) |
| `templates` | Homescreen-Vorlage, `config` als JSON (Zeilen, Bibliotheksoptionen, Rotation) |
| `layout_groups` / `layout_group_users` | genau eine Vorlage je Gruppe; ein Benutzer in höchstens einer Gruppe (`UNIQUE`) |
| `user_layout_state` | welche Vorlage zuletzt geschrieben wurde + Hash des Ergebnisses (für automatische Aktualisierung) |
| `rotation_state` | aktuelle Rangliste des Pools, Würfel-Schlüssel (Datum), Zähler für „neu würfeln“ |
| `rotation_history` | gezeigte Kollektionen mit Zeitpunkt |
| `backups` | Startseite + relevante Einstellungen eines Benutzers vor jeder Änderung; erstes = „Original“ |
| `snapshots` | Diagnose-Rohdaten |
| `change_log` | jede Änderung inkl. Dry-Run |
| `known_users` / `known_aperture_libs` | für „neu erkannt“ im Abgleich |

### Vorlagen-Format (`templates.config`)

```json
{
  "rows": [
    { "kind": "section", "sectionType": "resume" },
    { "kind": "aperture", "mediaType": "movies", "apertureStyle": "items", "sortBy": "Random" },
    { "kind": "collection", "collectionId": "123", "collectionName": "Marvel" },
    { "kind": "seasonal", "collectionName": "Weihnachten", "season": { "from": "12-01", "to": "12-26" } },
    { "kind": "rotation", "sortBy": "Random" },
    { "kind": "section", "sectionType": "latestmediablock", "libraries": { "mode": "except", "guids": ["@aperture:movies"] } }
  ],
  "libraryOrder": ["@aperture:movies", "<guid>", "…"],
  "myMediaHidden": ["@aperture:series"],
  "latestHidden": [],
  "hidePlayedInLatest": false,
  "landing": { "<guid>": "suggestions" },
  "tvHome": "",
  "rotation": {
    "enabled": true, "interval": "daily|weekly", "weekday": 1, "time": "04:00",
    "avoidLastN": 3, "minVisibleRatio": 0.5,
    "pool": [{ "collectionId": "…", "collectionName": "…", "weight": 1 }],
    "seasonal": [{ "collectionName": "Halloween", "season": { "from": "", "to": "" } }]
  }
}
```

`@aperture:movies` / `@aperture:series` sind Platzhalter, die pro Benutzer durch dessen eigene
Aperture-Bibliothek ersetzt werden.

## Regeln

- **Effektive Rechte** = Bibliotheken aller Gruppen des Benutzers + eigene Aperture-Bibliotheken.
  Fremde Aperture-Bibliotheken nie. Strengste Altersfreigabe gewinnt; nicht bewertete Typen und
  gesperrte Tags werden vereinigt. Benutzer ohne Gruppe werden nicht angefasst.
- **Rotation**: gewichtete Zufallsreihenfolge des Pools, zuletzt gezeigte N ans Ende. Pro Benutzer
  die ersten Kollektionen, die existieren, Inhalte haben und von denen er mindestens
  `minVisibleRatio` sehen darf (Emby zählt die Inhalte als dieser Benutzer – Bibliotheken,
  Altersfreigabe und Tags sind damit berücksichtigt). Aktive saisonale Kollektionen belegen
  zuerst Plätze. Würfeln ist deterministisch (Vorlage + Datum + Zähler), daher ist die Vorschau
  „morgen / nächste Woche“ genau das, was dann passiert – solange sich Pool und Kollektionen nicht
  ändern.
- **Schreiben der Startseite**: Backup → neue Zeilen anhängen → alte löschen → Reihenfolge prüfen
  und ggf. korrigieren → Bibliotheksreihenfolge/-ausblendungen → Startansichten. Nie „erst alles
  löschen“, weil Emby bei leerer Liste wieder seine Standardzeilen zeigt und speichert.

## Meilensteine

- **M1** Verbindung + Benutzer-/Bibliotheksübersicht, Login, Aperture-Zuordnung
- **M2** Bibliotheksgruppen, Kinderprofile, Altersfreigaben, Vorschau/Diff, Anwenden
- **M3** Homescreen-Vorlagen, Layout-Gruppen, Kollektionszeilen, saisonale Zeilen, Rotation
- **M4** Abgleich, Backups/Wiederherstellung, Diagnose, Dry-Run, Protokoll, Docker/CI
