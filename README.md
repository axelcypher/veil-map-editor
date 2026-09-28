# Veil Map Editor

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
- **Bei Versionserhöhung:** Ein Push auf `main`, der die Version in `src-tauri/tauri.conf.json` ändert, baut beide und hängt die Dateien an das Release `v<Version>` (wird angelegt, falls es fehlt). `package.json`, `tauri.conf.json` und `Cargo.toml` müssen dieselbe Version tragen, sonst bricht der Lauf ab.

Die APK wird signiert, wenn diese Repository-Secrets gesetzt sind: `ANDROID_KEYSTORE_BASE64` (die `.jks`-Datei als Base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Ohne sie bleibt sie unsigniert.

```bash
keytool -genkeypair -keystore veil-release.jks -alias veil -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 veil-release.jks   # Inhalt als ANDROID_KEYSTORE_BASE64
```

## Windows-Build

```powershell
npm run tauri build
```

Der vorherige Höheneditor mit eigenem Voronoi-Mesh liegt im Git-Tag `v0.3.2-terrain`; sein Quellcode unter `src/` wird nicht mehr gebaut.
