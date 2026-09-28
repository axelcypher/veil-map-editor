# Drittanbieter-Hinweise

## Bibliotheken (über npm bzw. Cargo eingebunden)

| Paket | Lizenz | Zweck |
| --- | --- | --- |
| [OpenLayers](https://openlayers.org/) | BSD-2-Clause | Kartendarstellung in EPSG:4326 |
| [Preact](https://preactjs.com/), @preact/signals | MIT | Oberfläche |
| [polygon-clipping](https://github.com/mfogel/polygon-clipping) | MIT | Flächen vereinigen, abziehen, an der Küste zuschneiden |
| [yaml](https://eemeli.org/yaml/) | ISC | Frontmatter der Obsidian-Notes lesen |
| [Tauri](https://tauri.app/) und Plugins | MIT / Apache-2.0 | Desktop-Rahmen |
| [image](https://github.com/image-rs/image), [rayon](https://github.com/rayon-rs/rayon), [blake3](https://github.com/BLAKE3-team/BLAKE3) | MIT / Apache-2.0 | Raster lesen, parallel rechnen, Datei-Hashes |
| [gifenc](https://github.com/mattdesl/gifenc) | MIT | GIF-Animationen des Globus |
| [webp](https://github.com/jaredforth/webp) mit [libwebp](https://chromium.googlesource.com/webm/libwebp) | MIT / Apache-2.0, libwebp BSD-3-Clause | Kacheln im Archiv als WebP |
| [zip](https://github.com/zip-rs/zip2) | MIT | `.veilmap`-Archiv |

## Vorlagen und Werte

- **Azgaar's Fantasy Map Generator** (MIT, Copyright 2017-2024 Max Haniyeu) diente als Funktionsvorlage. Code ist nicht übernommen; aus FMG stammt die Faustformel für die Stadtgröße des Plan-Generators (`2,13 · (Einwohner/1000)^0,385`).
- **World Orogen** (GPL-3.0, raguilar011095/planet_heightmap_generation): Übernommen sind nur die Farbwerte der Köppen-Klassen, damit die Klimakarte ohne Handarbeit zugeordnet wird. Kein Code.
- **Stadtplan-Generatoren** von watabou werden nur verlinkt (Parameter in der URL), nicht eingebunden.
- Der 3D-Viewer stammt aus dem eigenen Archivstand `v0.3.2-terrain`.
