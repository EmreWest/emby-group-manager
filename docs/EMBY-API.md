# Was wurde wie verifiziert?

Stand: 28.10.2026. Grundlage ist **Emby Server 4.10.2.0** (offizielles Release aus
`MediaBrowser/Emby.Releases`), **Aperture v0.7.10** sowie die aktuellen Quellen von
**Ultimate Collections** und **Home Screen Companion 4.5.0.0**.

Wie geprüft wurde:

- **Emby-Web-Client** (`dashboard-ui`, im Server-Paket enthalten) gelesen: die Startseiten-
  Einstellungen (`settings/homescreen.js`, `settings/sectioneditor.js`), der API-Client
  (`modules/emby-apiclient/apiclient.js`) und die Benutzerverwaltung (`users/accesstab.js`,
  `users/parentalcontroltab.js`). Das zeigt, was die Emby-Oberfläche selbst sendet, wenn man dort
  etwas ändert.
- **Emby.Api.dll / MediaBrowser.Model.dll**: Routen-Attribute und Datenmodelle über die .NET-
  Metadaten ausgelesen (kein Emby-Code ausgeführt).
- **Kein Live-Test gegen einen Emby-Server.** Das Ausführen des heruntergeladenen Servers war in
  dieser Umgebung nicht möglich. Deshalb hat die App die Seite **Diagnose**: Snapshot eines
  Testbenutzers, Änderung in der Emby-Oberfläche, zweiter Snapshot, Vergleich. Damit lässt sich
  jede Aussage unten an deinem Server bestätigen (Anleitung im README).

## Startseite (Homescreen)

| Was | Wo Emby es speichert | Quelle |
|---|---|---|
| Zeilen der Startseite | `GET/POST /Users/{UserId}/HomeSections`, `POST …/HomeSections/Move` `{Ids, NewIndex}`, `POST …/HomeSections/Delete` `{Ids}` | `apiclient.js` (`getHomeScreenSections`, `saveHomeScreenSection`, …), Routen in `Emby.Api.dll` |
| ab welcher Version | serverseitig ab **4.10.0.4** (`supportsServerHomeSections`) | `apiclient.js` |
| Bezug | **pro Benutzer**, nicht pro Gerät/Client | Route enthält nur `UserId`; früher `DisplayPreferences/usersettings?client=emby` |
| Format einer Zeile | `ContentSection`: `SectionType, CustomName, Subtitle, ViewType, ImageType, DisplayMode, ScrollDirection, ParentId, SortBy, SortOrder, ItemTypes, IncludeNextUpInResume, ExcludedFolders, Query, CardSizeOffset, RefreshInterval` (+ vom Server gesetzt: `Id, Name, ParentItem, …`) | `MediaBrowser.Model.dll`, `sectioneditor.js` `onSubmit` |
| Zeilentypen in der UI | `userviews, resume, resumeaudio, latestmediablock, collections, playlists, boxset, playlist, items, latestmoviereleases, latestepisodereleases, onnow, activerecordings` | `sectioneditor.template.html` |
| Bibliotheksfilter einer Zeile | `ExcludedFolders` = **Item-Ids** der Ansichten (`/Users/{id}/Views`), die nicht gezeigt werden | `sectioneditor.js` |
| Neue Zeile | `POST /Users/{id}/HomeSections` ohne `Id`; Emby vergibt die Id selbst und hängt hinten an | Ultimate Collections, `EmbyHomeScreens.cs` (dort am 12.10.2026 per REST getestet) |
| Benutzer ohne gespeicherte Zeilen | gespeichert ist eine **leere** Liste; `GET ?IsEditMode=true` liefert dann Embys Legacy-Standard (Meine Medien, Weiterschauen, Weiterhören, Jetzt im TV, Neu hinzugefügt). Die REST-Schicht speichert diese Standardzeilen vor der ersten Änderung (`EnsureSavedSections`). | `EmbyHomeScreens.cs` (Ultimate Collections, getestet 14.10.2026), Methodennamen `GetLegacyHomeSections`/`EnsureSavedSections` in `Emby.Api.dll` |
| Sortierung „Zufällig“ | `SortBy: "Random"`; der Client schickt beim Laden der Zeile einen `RandomSeed` an `GET /Users/{id}/Sections/{SectionId}/Items` → bei jedem Aufruf neu gemischt | `baseitemcontroller.js` (Option `Random` ab 4.8.0.11), `apiclient.js` `getHomeScreenSectionItems` |
| „Zufällig“ bei Kollektionszeilen | Die Emby-UI bietet für `boxset`-Zeilen **nur** Kollektionsreihenfolge, Titel, Hinzugefügt, Jahr, Bewertung, Laufzeit an. `SortBy` ist aber ein freies Textfeld. **Ob der Server `Random` hier mischt, ist nicht verifiziert** → per Diagnose prüfen | `getPlaylistOrCollectionSortMenuOptions("BoxSet")` |

### Weitere Startseiten-Einstellungen

| Was | Wo | Quelle |
|---|---|---|
| Bibliotheksreihenfolge | `User.Configuration.OrderedViews` (Werte: `Guid` bzw. `Id` der Ansicht) über `POST /Users/{id}/Configuration/Partial` | `homescreen.js` `onUserViewsMovedToNewIndex` |
| „Meine Medien“ ausblenden | `Configuration.MyMediaExcludes` (ab 4.10 blendet die UI diesen Schalter aus; maßgeblich sind die `ExcludedFolders` der `userviews`-Zeile – die App setzt beides) | `homescreen.js` `renderPerLibrarySettings` |
| „In anderen Startseitenbereichen anzeigen“ | `Configuration.LatestItemsExcludes` | dto. |
| Startansicht pro Bibliothek | Benutzereinstellung `landing-<Guid>` über `POST /UserSettings/{id}/Partial` | `homescreen.js` (`data-usersettingsfield="landing-…"`) |
| TV-Layout | Benutzereinstellung `tvhome` | `usersettingsbuilder.js` |
| Benutzereinstellungen allgemein | `GET /UserSettings/{id}`, `POST /UserSettings/{id}/Partial` (ab 4.9.0.23, vorher `DisplayPreferences/usersettings?client=emby`) | `apiclient.js` `getDisplayPreferences` |
| alte Schlüssel `homesection0..6` | nur noch für die Legacy-Standardwerte relevant | `usersettingsbuilder.js` |

## Benutzerrechte

| Was | Details | Quelle |
|---|---|---|
| Policy schreiben | nur `POST /Users/{Id}/Policy` mit der **ganzen** Policy, kein Partial-Endpunkt → die App liest direkt vorher und ändert nur ihre Felder | `Emby.Api.dll` (`UpdateUserPolicy`) |
| `EnabledFolders` | enthält die **Guid** der Bibliothek (`folder.Guid \|\| folder.Id` aus `/Library/SelectableMediaFolders` bzw. `/Library/VirtualFolders`) | `users/accesstab.js` |
| `MaxParentalRating` | Zahl (`Value` aus `/Localization/ParentalRatings`), `null` = keine Beschränkung | `parentalcontroltab.js`, `UserPolicy` |
| `BlockUnratedItems` | **Liste** von Typen: `Movie, Trailer, Series, Music, Game, Book, LiveTvChannel, LiveTvProgram, ChannelContent, Other` (kein Boolean) | `UserPolicy`, Enum `UnratedItem` |
| `BlockedTags` | Liste von Tags | `UserPolicy` |

Von der App geschriebene Policy-Felder: `EnableAllFolders, EnabledFolders, MaxParentalRating,
BlockUnratedItems, BlockedTags`. Alles andere geht unverändert zurück.

## Aperture (v0.7.10)

| Methode | Details | Quelle |
|---|---|---|
| API | `GET /api/users` (enthält `provider_user_id` = Emby-Benutzer-Id) und `GET /api/settings/strm-libraries` (`userId, providerLibraryId, mediaType, channelId`), beide `requireAdmin`; Header `X-API-Key: apt_…` | `apps/api/src/routes/users/handlers/list.ts`, `…/settings/handlers/aiOutput.ts`, `plugins/auth.ts` |
| Datenbank | Tabelle `strm_libraries` (`user_id, channel_id, name, path, provider_library_id, provider_library_guid, media_type, library_type`) + `users.provider_user_id` | `db/migrations/0011, 0020, 0037, 0062` |
| Ordnerpfad | Filme: `<prefix>/aperture/<Name>_<EmbyUserId>`, Serien: `<prefix>/aperture-tv/<Name>_<EmbyUserId>` | `packages/core/src/strm/{movies,series}/library.ts`, `filenames.ts` |
| Name | Vorlage `{{username}}`/`{{type}}` in Aperture (Standard „{{username}}'s AI Picks - Movies“), pro Benutzer überschreibbar | `systemSettings.ts`, `userSettings.ts` |
| Eigene Rechtevergabe | Aperture fügt die Bibliothek selbst zu `EnabledFolders` des Besitzers hinzu (nicht bei `EnableAllFolders`) | `strm/movies/library.ts` `updateUserLibraryPermissions` |
| Version | `GET /api/version` (ohne Anmeldung) | `apps/api/src/routes/api.ts` |

## Kollektions-Plugins

| Plugin | Verhalten außerhalb der Saison / des Zeitplans | Quelle |
|---|---|---|
| Ultimate Collections | saisonale Kollektion wird außerhalb des Fensters **gelöscht** und zum Saisonstart **neu angelegt** (neue Item-Id) → die App sucht saisonale Kollektionen über den Namen. Saisonfenster: `GET /UltimateCollections/Status` → `Collections[].Season` („Oct 1 – Oct 31“), `Active`, `NextStart` | `Core/Syncer.cs` (`DeleteOwned("off season")`), `Emby/StatusApi.cs` |
| Ultimate Collections – Startseite | eigene Startseiten-Funktion; bei neuen Benutzern verschwanden die Standardzeilen (Fix #1 „new users lost default home screen rows“). Wird hier nicht genutzt – bitte im Plugin ausgeschaltet lassen | `CHANGELOG.md`, `EmbyHomeScreens.cs` |
| Home Screen Companion | Einträge außerhalb ihres Zeitplans (`ActiveIntervals`) werden beim Lauf übersprungen; bei leerem Ergebnis werden Tags/Kollektion geleert, sofern „Preserve … on empty result“ aus ist | `HomeScreenCompanionTask.cs` |

Die Regel der App deckt beides ab: eine saisonale Zeile erscheint nur, wenn die Kollektion
**existiert und Inhalte hat** (und der Benutzer genug davon sehen darf).
