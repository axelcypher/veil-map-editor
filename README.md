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
| `web/view3d/` | 3D-Gelände und Globus (WebGL 2) |
| `src-tauri/src/` | Heightmap-Prüfung und Kachelung, Küstenpolygone (Marching Squares), Flussvektorisierung (Zhang-Suen, Graph, Haupt- und Nebenflüsse), Köppen-Klassifizierung, Vault-Zugriff |

Die Rasterarbeit übernimmt Rust selbst, GDAL wird nicht gebraucht: Der Import schreibt Relief- und Schummerungskacheln (256 px, Zoomstufen bis zur vollen Auflösung), ein 4096 × 2048-Höhenraster, die Küstenpolygone und die vollen Höhen in den App-Cache (`%LOCALAPPDATA%\de.veil.map-editor`). Fehlt der Cache, wird er beim Öffnen aus der Quelldatei neu gebaut, mit allen Prüfungen.

## Projektdatei

`.veil` ist JSON: Planetenradius, Verweise auf die importierten Dateien (Pfad und Hash), Kontrollpunkte, alle Elemente mit GeoJSON-Geometrie in Grad, Diplomatie, Typenlisten, Stile, Ebenen und Presets, Vault-Pfad. Flächen werden so gespeichert, wie sie gezeichnet wurden; der Zuschnitt an der Küste wird bei der Anzeige und beim Export berechnet und folgt so jedem neuen Gelände.

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

## Windows-Build

```powershell
npm run tauri build
```

Der vorherige Höheneditor mit eigenem Voronoi-Mesh liegt im Git-Tag `v0.3.2-terrain`; sein Quellcode unter `src/` wird nicht mehr gebaut.
