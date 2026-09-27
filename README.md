# Veil Map Editor

Desktop-Höheneditor für maßstäbliche Fantasy-Karten auf Basis von Tauri und TypeScript.

## Höhenmesh

Die Karte besteht aus einem reproduzierbaren Voronoi-Mesh über einem verrauschten Quadratgitter, wie im Fantasy Map Generator. Seed, Basis-Zellzahl, Kartenproportionen und die verfeinerten Blöcke legen die Zellen fest, jede Zelle besitzt einen Höhenwert in Metern. Land und Wasser ergeben sich aus dem Vergleich mit dem Meeresspiegel. Die Zellen werden in einem einzigen WebGL-Aufruf gezeichnet, ein Pinselstrich lädt nur eine kleine Farbtextur neu. Dadurch bleiben auch 100.000 und mehr Zellen flüssig.

Der aktuelle Stand bietet:

- globale 2:1-Weltkarten und frei definierte Ausschnitte
- Planetendaten, reale Kartenausdehnung und kilometerbasierte Pinsel
- ab 1.000 Basiszellen ohne Obergrenze (über 1 Mio. fragt die App vorher nach); bei einer Änderung von Seed werden die Höhen übernommen
- Auflösung: Zellzahl und Zellgröße (km) hängen zusammen und werden im Projekt eingestellt, ohne Obergrenze; so modelliert man die ganze Karte direkt in voller Auflösung. Optional verfeinert sich das Mesh beim Malen in hineingezoomter Ansicht (Quadtree, nur unter dem Pinsel, aus per Voreinstellung)
- Undo und Redo schließen die Verfeinerung ein
- Pinsel (Radius 1 bis 1.000 km, logarithmischer Regler in ganzen km): Anheben, Absenken, Glätten, Zielhöhe, Aufrauen, dazu Gebirgszug und Graben zwischen zwei Punkten; wahlweise nur auf Land oder Wasser
- Landschaft im Land: erzeugt Hügel und Berge nur innerhalb der vorhandenen Landmasse; Meer und Küste bleiben, von Hand gesetzte Höhen ab einer Schwelle bleiben stehen und bekommen Ausläufer. Regler für Höhe, Strukturgröße, Gebirgigkeit, Anstieg von der Küste, Schwelle, Einmischen des Bestehenden und Auffüllen von Senken (weniger Seen)
- Höhenvorlagen aus dem Fantasy Map Generator (Kontinente, Archipel, Atoll und weitere), Graustufenbild als Höhenkarte, Alles glätten
- Flüsse und Seen aus Regen und Gefälle; Senken füllen sich bis zum Überlauf zu Seen, ohne die gemalten Höhen zu verändern
- Gebiete mit Grenzen und Namen (Malen, Radieren, ganze Insel füllen), die Namen folgen der Form des Gebiets
- Zonen als überlappende Flächen (Gefahr, Magie, Krieg ...) mit Schraffur, Muster oder Fläche
- Marker für Städte und Orte in zwölf Arten, mit Größe, Beschriftung und Notiz; verschiebbar
- Routen für Seewege, Straßen, Pfade und Luftwege, gezeichnet oder automatisch durch Wasser bzw. über Land gesucht, mit Länge in km; Wegpunkte lassen sich nachträglich ziehen, auf der Linie einfügen und mit Alt löschen; dazu von Hand gezeichnete Flüsse, die zur Mündung breiter werden
- drei Ebenen: Oberfläche, unterirdisch (Höhlen) und Luft (schwebende Inseln), jede mit eigener Höhenkarte und allen Overlays. Die Höhlen hängen an der Oberfläche: sie liegen mindestens 30 m unter dem Boden und nicht unter tiefem Meer (unter der tiefsten Höhle, einstellbar); der Umriss der Oberfläche liegt als Schatten unter der unterirdischen Ebene, tiefes Meer dunkler, und als Schatten unter der Luftebene
- 3D-Ansicht und Globus in einem verschiebbaren Fenster neben der Karte (Knopf „3D / Globus“ oben): das Gelände mit Überhöhung, drehen mit der Maus, Verschieben mit rechter Taste, Zoom mit dem Mausrad; der Globus zeigt die Karte auf der Kugel des Planeten. Beide folgen der aktiven Ebene und der gewählten Kartenansicht
- Klima: Temperatur nach Breitengrad und Höhe, Niederschlag durch Windsimulation mit Regenschatten
- 13 Biome aus Temperatur und Feuchtigkeit, dazu erkannte Inseln, Seen und Ozeane
- fraktale Küstenlinien mit allen acht Reglern des Fantasy Map Generator, für die ganze Karte oder für eine einzelne Insel oder einen See
- Höhenfarben, reduzierte Land-/Wasser-Ansicht oder Biomkarte
- frei einstellbarer Meeresspiegel; Klima und Küste folgen automatisch
- Pinsel wie in Bildbearbeitung: Alt und Mausrad ändern den Radius, Umschalt und Mausrad die Stärke, die Tasten [ und ] den Radius
- Werkzeugpalette mit den Modi Höhen, Klima, Wasser, Küste, Gebiete, Zonen, Marker, Routen und Projekt; jeder Modus zeigt seine eigenen Einstellungen und eine passende Kartenansicht. Gemalt wird nur im Höhenmodus
- Umschaltbare Kartenansicht über der Karte: Höhen, Land/Wasser, Biome, Temperatur, Niederschlag, mit Legende
- Seitenleiste per Ziehen am Rand in der Breite verstellbar (Doppelklick setzt zurück), Version und Build-Zeit in der Fußzeile
- Zoom mit dem Mausrad, Verschieben mit mittlerer oder rechter Maustaste oder Leertaste
- Undo und Redo pro Pinselstrich
- eingebettete PNG-, JPEG- und WebP-Vorlagen
- Speichern und Laden als `.veilmap`
- PNG-Export ohne Vorlagenbild und Bedienoberfläche

Klima, Biome und Küsten werden kurz nach dem letzten Pinselstrich neu berechnet (bei 100.000 Zellen etwa 0,15 s). Bis dahin zeigt die Karte die Zellen roh.

## Projektformat

Eine `.veilmap`-Datei ist eine GeoJSON-`FeatureCollection` mit Veil-Metadaten (Format 5). `veil.mesh` hält Seed und Zellzahl, jede Ebene in `veil.layers` ihre geteilten Blöcke (`splits`), die Höhen in der Reihenfolge der Zellen, Gebiets- und Zonenflächen als Läufe sowie Gebiete, Zonen, Marker und Routen; Flüsse und Seen werden nicht gespeichert, sondern abgeleitet; Zellpunkte, Voronoi-Polygone, Klima, Biome und Küsten werden daraus abgeleitet. `veil.climate` und `veil.coast` halten die Einstellungen. Dateien der Formate 2, 3 und 4 werden beim Öffnen auf das neue Mesh übertragen.

## Entwicklung

Voraussetzungen: Node.js, Rust mit Cargo, Microsoft C++ Build Tools und WebView2.

```powershell
npm install
npm run tauri dev
```

## Windows-Build

```powershell
npm run tauri build
```

Die direkt startbare Anwendung und die Installer werden anschließend unter `src-tauri/target/release` erzeugt.

## Automatischer UI-Test

Während der Vite-Entwicklungsserver läuft:

```powershell
node scripts/ui-smoke.mjs
```

Der Test zeichnet mit Microsoft Edge einen Höhenstrich, prüft die Höhenänderung an der Zelle in der Kartenmitte und anschließend Undo. Er braucht den Entwicklungsserver, weil die App dort ihre Höhen als `window.__veil` bereitstellt.

## Lizenzen

Die Terrain-Module sind aus dem MIT-lizenzierten [Fantasy Map Generator](https://github.com/Azgaar/Fantasy-Map-Generator) portiert, siehe [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
