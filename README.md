# VEIL Map Editor

Supplement-Editor für die Weltkarte von Thessari: Städte, Routen, Staaten, Provinzen, Kulturen, Religionen, Zonen, Marker, Beschriftungen, Militär und Diplomatie auf einer fertigen Karte. Tauri-Desktop-App, die Logik liegt vollständig im Frontend (`web/`).

**Datenfluss:** PS-Heightmap → Gaea → Veil-Editor → GeoJSON + Zusatzinfos → GPlates

## Grundsätze

- **Gelände ist schreibgeschützt.** Der Editor generiert nichts und ändert kein Relief. Relief ändern heißt: zurück nach Photoshop bzw. Gaea und neu importieren.
- **Import mit Prüfung.** 2:1, 16 Bit Graustufen, unsere Höhenkodierung (Höhe = Dateiwert × 32.768 / 65.535 − 16.384 m), keine Normalisierung, Kontrollpunkte an bekannten Stellen. Ein Fehler bricht den Import ab; nichts wird still umgerechnet. Quadratische Gaea-Exporte lassen sich auf ausdrücklichen Wunsch mittig auf 2:1 zuschneiden.
- **Naturdaten nur per Import.** Flüsse aus der Gaea-Flow-/Rivers-Maske, Klima aus der Köppen-Karte von World Orogen. Im Editor werden sie benannt und beschrieben, nicht verschoben.
- **Neuimport ohne Datenverlust.** Alles hängt an Grad-Koordinaten (EPSG:4326), nicht an Rasterzellen. Nach einem Neuimport listet „Daten → Konflikte“ z. B. Städte, die jetzt im Meer liegen. Flussnamen wandern zur neuen Linie am selben Ort.

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `web/platform/` | Adapter-Schicht: `tauri.ts` (Desktop, Rust), `web.ts` (Browser: Upload/Download, Obsidian über das Plugin „Local REST API“) |
| `web/model/` | Projektdaten, Undo, Importe, Konflikte, Export, Obsidian, Zuschnitt an der Küste (Web Worker) |
| `web/map/` | OpenLayers-Karte, Stile, Texturen |
| `web/ui/` | Oberfläche (Preact) |
| `web/view3d/` | 3D-Gelände und Globus (WebGL 2), Globus-Export als PNG, GIF und WebM |
| `src-tauri/src/` | Heightmap-Prüfung und Kachelung, Satellitenbild-Kacheln, Küstenpolygone (Marching Squares), Flussvektorisierung (Zhang-Suen, Graph, Haupt- und Nebenflüsse), Köppen-Klassifizierung, `.veilmap`-Archiv, Vault-Zugriff |
| `src-tauri/gen/android/` | Android-Projekt (von `tauri android init`) |

Die Rasterarbeit übernimmt Rust selbst, GDAL wird nicht gebraucht: Der Import schreibt Relief- und Schummerungskacheln (256 px, Zoomstufen bis zur vollen Auflösung), ein 4096 × 2048-Höhenraster, die Küstenpolygone und die vollen Höhen in den App-Cache (`%LOCALAPPDATA%\de.veil.map-editor`). Fehlt der Cache, wird er beim Öffnen aus der Quelldatei neu gebaut, mit allen Prüfungen.

## Oberfläche

Anthrazit mit entsättigtem Purpur als Akzent und kaltem Silber als zweitem Akzent, runde Knöpfe. Oben links stehen Logo und die Reiter der Seitenleiste (Ebenen, Stil, Daten, Projekt) als Text-Tabs über der Seitenleiste, rechts Datei, Speichern, Rückgängig/Wiederholen und 3D. Auf dem Desktop ersetzt diese Leiste die Fensterleiste des Systems: freie Flächen verschieben das Fenster, Doppelklick maximiert. Der Schriftzug VEIL steht in Aref Ruqaa Ink; Cinzel, Forum und Marcellus stehen außerdem für Beschriftungen zur Wahl. Alle Schriften sind in der App enthalten.

Das Logo liegt als Quelle in `src-tauri/icons/the_veil_logo_map_editor.svg`. Daraus abgeleitet: `web/assets/logo.svg` (einfarbig, folgt der Textfarbe), `public/favicon.svg` (dunkel oder weiß je nach System-Theme), `src-tauri/icons/app-icon.svg` (weiß auf Anthrazit, Quelle für `npm run tauri icon`) und `src-tauri/icons/android-foreground.svg` (Vordergrund und monochrome Ebene des adaptiven Android-Icons; Android 13+ färbt es passend zum Theme).

## Satellitenbild

Ein Farbexport aus Gaea (2:1, bei quadratischem Export die Mitte ausschneiden) wird wie das Relief zu einer Kachelpyramide und erscheint als Ebene „Satellitenbild“ (Preset „Satellit“). Der Globus kann es als Oberfläche tragen. Es ist nur Anzeige; das Gelände kommt weiter aus der Heightmap.

## Bildebenen

Unter „Projekt → Bildebenen“ lassen sich beliebig viele weitere Bilder der ganzen Welt als eigene Ebenen hinzuladen, etwa vorgerenderte Kartenstile. Sie werden wie das Satellitenbild gekachelt (2:1, bei quadratischem Export die Mitte ausschneiden). Transparenz bleibt erhalten, sodass auch eine Ebene nur mit Grenzen oder Schrift darüber liegen kann. Reihenfolge, Deckkraft und Filter stehen unter „Ebenen“; der Globus kann jede Bildebene als Oberfläche tragen. Im Archiv reisen sie mit (abwählbar).

## Projektdatei

`.veil` ist JSON: Planetenradius, Verweise auf die importierten Dateien (Pfad und Hash), Kontrollpunkte, alle Elemente mit GeoJSON-Geometrie in Grad, Diplomatie, Typenlisten, Stile, Ebenen und Presets, Vault-Pfad. Flächen werden so gespeichert, wie sie gezeichnet wurden; der Zuschnitt an der Küste wird bei der Anzeige und beim Export berechnet und folgt so jedem neuen Gelände.

## Archiv `.veilmap`

„Datei → Als Archiv speichern“ packt das Projekt mit allem, was aus den Quelldateien abgeleitet wurde, in eine ZIP-Datei – zum Weitergeben, vor allem an das Tablet:

| Eintrag | Inhalt |
| --- | --- |
| `veilmap.json` | Kennungen, Stempel, Einstellungen |
| `project.veil` | das Projekt |
| `terrain/<id>/` | Relief- und Schummerungskacheln (WebP), Höhenraster 4096 × 2048 und optional die Höhen (16-Bit-PNG, verlustfrei), Küstenpolygone, `meta.json` |
| `koppen/<id>/` | Klimaklassen und `meta.json` (abwählbar) |
| `satellite/<id>/` | Kacheln des Satellitenbilds und der Bildebenen (WebP, mit Transparenz, abwählbar) |

Die Kacheln werden beim Speichern von PNG nach WebP umgerechnet (Qualität einstellbar, Vorgabe 85, wahlweise verlustfrei) und ohne erneute Kompression abgelegt; schon vorhandene WebP-Kacheln laufen unverändert durch. Exakte Höhen gibt es in drei Stufen: nur das ≈10-km-Raster, halbe oder volle Auflösung. Richtwerte für eine 16k-Karte: Kacheln und Raster ~20–60 MB, halbe Höhen +~30 MB, volle Höhen +~100 MB. Quelldateien werden nie eingebettet.

Beim Öffnen wird eine Datei am Inhalt erkannt (ZIP oder JSON). Ein Archiv wird in den App-Cache entpackt; ein eigener Import auf dem PC bleibt dabei unangetastet, ein Cache aus einem anderen Archiv wird am Stempel erkannt und ersetzt. „Speichern“ schreibt ein geöffnetes Archiv wieder als Archiv.

## Sync-Server

Die App synchronisiert Projekte über den Dienst **veilmap-sync**, dessen Implementierung unter [`sync-server/`](sync-server/) liegt. Unter „Datei → Synchronisierung …“ die **Server-Adresse** als Basis-URL ohne `/v1/items` eintragen; eine Server-Adresse ist voreingestellt. Bei einem eigenen Server diese durch dessen erreichbare Adresse ersetzen. Der Server lauscht intern per HTTP auf `0.0.0.0`, standardmäßig auf Port `8080` (Umgebungsvariable `SYNC_PORT`); für HTTPS wird ein vorgeschalteter Proxy benötigt. „Verbindung testen“ prüft zuerst `GET /health` und anschließend mit dem eingetragenen Code `GET /v1/items`.

**Spaces (Workspaces/Bereiche):** Ein geheimer Code öffnet einen eigenen Bereich mit benannten Einträgen; die App speichert darin ein Projekt pro Eintrag. Auf allen Geräten dieselbe Server-Adresse und denselben Code verwenden, um dieselben Projekte zu erreichen. „Neu“ erzeugt einen zufälligen Code mit 32 Zeichen. Die App sendet ihn als `Authorization: Bearer <code>`; der Server akzeptiert 24–512 Bytes und leitet den Speicherordner aus einem Hash des Codes ab. Der Code ist der Zugangsschlüssel zum Space und muss geheim bleiben. Ein anderer Code öffnet einen anderen Bereich; der bisherige bleibt mit seinem bisherigen Code erreichbar.

**Server-Key / Authentifizierung:** Ist serverseitig die Umgebungsvariable `SYNC_SERVER_KEY` nicht leer gesetzt, ihren Wert in der App als „Server-Schlüssel“ eintragen. Die App übermittelt ihn im Header `X-Server-Key`. Der Server verlangt ihn nur beim ersten Upload in einen neuen Space; fehlt er oder ist er falsch, antwortet er mit HTTP `403`. Bestehende Spaces benötigen nur ihren Code. Ohne gesetzten Server-Key können neue Spaces ohne diesen zusätzlichen Schlüssel entstehen. Ein erfolgreicher Verbindungstest allein bestätigt deshalb noch nicht, dass ein neuer Space angelegt werden darf.

Nach „Übernehmen“ lädt „Mit dem Server verknüpfen“ das aktuelle Projekt hoch; auf anderen Geräten lässt es sich unter „Auf dem Server“ öffnen. Der Abgleich nutzt `GET` und `PUT` auf `/v1/items/{name}`. Schreibzugriffe nennen mit `If-Match` die zugrunde liegende Revision; bei einem veralteten Stand antwortet der Server mit HTTP `409`, damit die App den Konflikt behandeln kann. Synchronisiert werden die Projektdaten als JSON; Gelände und Bilder bleiben lokal auf jedem Gerät. Weitere Angaben zu Betrieb, Speichergrenzen und API stehen in der [Server-Dokumentation](sync-server/README.md).

## Globus

Die 3D-Ansicht zeigt im Modus „Globus“ die Karte, das Satellitenbild oder das Relief auf der Kugel, mit Relief aus dem Höhenraster. Einstellbar sind Drehtempo und -richtung, Achsneigung, Sonne mit Tag-Nacht-Grenze, Atmosphäre, Wolken, Gradnetz und Hintergrund (transparent, Farbe, Sternenhimmel). Export: Standbild als PNG (mit Alphakanal), eine ganze Umdrehung als nahtlos loopendes GIF oder als WebM. Die Einstellungen stehen im Projekt.

## Export

- **GeoJSON** (eine Datei oder eine je Ebene): Koordinaten in Grad, −180…180 / −90…90, CRS-Angabe `+proj=longlat +R=6606727`. In GPlates erhalten die Elemente über „Assign Plate IDs“ die Plate-ID ihres Blocks. Optional mit dem Frontmatter der verknüpften Notes.
- **JSON**: alle Kartendaten mit aufgelösten Namen und abgeleiteten Werten (Flächen, Bevölkerung).

## Entwicklung

Voraussetzungen: Node.js, Rust mit Cargo, Microsoft C++ Build Tools und WebView2.

```powershell
npm install
npm run tauri dev
```

Rust-Tests: `cargo test --lib` in `src-tauri`. Die Probeläufe gegen echte Dateien sind mit `--ignored` abrufbar (siehe `src-tauri/src/probe_tests.rs`).

## Android

Importiert wird am PC; das Gerät bekommt das fertige Archiv. Die App läuft im Vollbild: Status- und Navigationsleiste erscheinen nur nach einem Wischen vom Rand. Auf Touch-Geräten und in schmalen Fenstern werden Seitenleiste und Inspektor zu Schubladen; beim Zeichnen gibt es Knöpfe für Freihand, „Punkt zurück“ und „Übernehmen“, im Stützpunkt-Werkzeug einen Löschen-Schalter. Der Obsidian-Vault wird über den Pfad gelesen und braucht unter Android 11+ „Zugriff auf alle Dateien“ (App-Infos → Berechtigungen).

Voraussetzungen: Android SDK mit NDK, JDK 17+, Rust-Targets `aarch64-linux-android` (und nach Bedarf `armv7-linux-androideabi`, `x86_64-linux-android`).

```bash
export ANDROID_HOME=… NDK_HOME=$ANDROID_HOME/ndk/<version>
npm run tauri android build -- --apk --target aarch64
```

Die Release-APK ist unsigniert; zum Installieren mit `apksigner` signieren (eigener Schlüssel) oder `npm run tauri android dev` mit angeschlossenem Gerät nutzen.

## Builds auf GitHub

Zwei Workflows unter `.github/workflows/` bauen Windows (MSI und NSIS-Installer) und Android (APK, arm64):

- **Von Hand:** Actions → Workflow wählen → „Run workflow“. Das Ergebnis liegt als Artefakt am Lauf.
- **Bei Versionserhöhung:** Ein Push auf `main` baut, solange dem Release `v<Version>` (Version aus `package.json`) die jeweilige Datei fehlt – dem Windows-Workflow das MSI, dem Android-Workflow die APK –, und hängt sie daran; das Release wird bei Bedarf angelegt. Ist ein Lauf gescheitert, holt der nächste Push auf `main` ihn nach. `package.json` ist die einzige Stelle für die Version: `tauri.conf.json` liest sie von dort (`"version": "../package.json"`), und daraus leiten sich Installer-Name und Android-`versionCode` ab. Die Version in `Cargo.toml` betrifft nur die Rust-Bibliothek intern.

Die APK wird signiert, wenn diese Repository-Secrets gesetzt sind: `ANDROID_KEYSTORE_BASE64` (die `.jks`-Datei als Base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Ohne sie bleibt sie unsigniert.

```bash
keytool -genkeypair -keystore veil-release.jks -alias veil -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 veil-release.jks   # Inhalt als ANDROID_KEYSTORE_BASE64
```

## Updates in der App

Beim Start sieht die App höchstens einmal am Tag im neuesten GitHub-Release nach (abschaltbar unter „Datei“), von Hand über „Datei → Nach Updates suchen“. Ist eine neuere Version da, erscheint unten rechts ein Update-Knopf.

- **Windows:** Die App lädt den Installer, prüft seine Signatur, installiert und startet neu (Tauri-Updater, `latest.json` im Release).
- **Android:** Die App lädt die APK über den Browser; Android installiert sie über die alte, weil beide mit demselben Schlüssel signiert sind.
- **Ohne Update-Schlüssel** (lokale Builds, Web) öffnet der Knopf die Release-Seite.

Der Update-Schlüssel ist ein eigenes Schlüsselpaar, getrennt vom Android-Schlüssel. Einmal erzeugen:

```bash
npx tauri signer generate -w veil-updater.key
```

Dann im Repository unter Settings → Secrets and variables → Actions anlegen:

| Art | Name | Inhalt |
| --- | --- | --- |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Inhalt von `veil-updater.key` |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | das Passwort (leer lassen, wenn keins) |
| Variable | `TAURI_UPDATER_PUBKEY` | Inhalt von `veil-updater.key.pub` |

Der Windows-Workflow signiert damit die Installer und legt `latest.json` ins Release. Installierte Versionen, die schon mit dem öffentlichen Schlüssel gebaut wurden, finden Updates von selbst; die erste solche Version muss einmal von Hand installiert werden. Den privaten Schlüssel gut aufheben: Ohne ihn kann keine installierte Version mehr ein Update annehmen.

## Windows-Build

```powershell
npm run tauri build
```

Der vorherige Höheneditor mit eigenem Voronoi-Mesh liegt im Git-Tag `v0.3.2-terrain`; sein Quellcode unter `src/` wird nicht mehr gebaut.
