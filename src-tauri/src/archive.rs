// The .veilmap archive: a project together with everything the import derived from the source files
// (terrain tiles, grid, coast, climate classes, the satellite picture, own image layers), so another device can show
// the map without the sources. A ZIP: tiles are WebP and stored as they are, the rest is deflated.
// Opening unpacks it into the app cache, where the rest of the app finds it like a local import.
use crate::heightmap;
use crate::tiles::{self, TileEncoding};
use image::ImageEncoder;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// marks a cache folder that was unpacked from an archive; holds the archive's stamp
pub const STAMP: &str = ".archive";
const MANIFEST: &str = "veilmap.json";
const PROJECT: &str = "project.veil";
const PARTS: [&str; 3] = ["terrain", "koppen", "satellite"];

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveOptions {
    /// the .veil JSON
    pub project: String,
    pub terrain_id: Option<String>,
    pub koppen_id: Option<String>,
    pub satellite_id: Option<String>,
    /// own image layers (pre-rendered map styles); stored like the satellite picture
    #[serde(default)]
    pub image_ids: Vec<String>,
    pub tiles: TileEncoding,
    /// heights for exact point heights and conflict checks: "none" (the ≈10 km grid always comes
    /// along), "half" (half resolution, a quarter of the size) or "full"
    #[serde(default = "no_heights")]
    pub heights: String,
}

fn no_heights() -> String {
    "none".into()
}

/// 2 × 2 blocks averaged in metres, wrapping east–west
fn halve_heights(raw: &[u8], width: usize, height: usize) -> (Vec<u8>, usize, usize) {
    let at = |x: usize, y: usize| heightmap::meters(u16::from_le_bytes([raw[(y * width + x) * 2], raw[(y * width + x) * 2 + 1]]));
    let (w, h) = (width / 2, height / 2);
    let mut out = vec![0u8; w * h * 2];
    out.par_chunks_mut(w * 2).enumerate().for_each(|(y, row)| {
        for x in 0..w {
            let m = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) * 0.25;
            row[x * 2..x * 2 + 2].copy_from_slice(&heightmap::encode(m).to_le_bytes());
        }
    });
    (out, w, h)
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    version: u32,
    /// unique per written archive; a cache unpacked from an older one is replaced
    stamp: String,
    created_at: u64,
    terrain: Option<String>,
    koppen: Option<String>,
    satellite: Option<String>,
    #[serde(default)]
    images: Vec<String>,
    full_heights: bool,
    quality: f32,
    lossless: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    pub bytes: u64,
    pub tiles: usize,
    pub tile_bytes: u64,
    pub heights_bytes: u64,
    pub full_heights: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub project: String,
    pub archive: bool,
    /// parts that were unpacked (the others were already in the cache)
    pub unpacked: Vec<String>,
}

pub fn is_zip(head: &[u8]) -> bool {
    head.len() >= 4 && &head[0..4] == b"PK\x03\x04"
}

fn now() -> (u64, u128) {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    (d.as_secs(), d.as_nanos())
}

/// all files below `dir`, as ("a/b/c.png", path), sorted
fn files_below(dir: &Path) -> Vec<(String, PathBuf)> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if path.is_dir() {
                walk(&path, &relative, out);
            } else {
                out.push((relative, path));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, "", &mut out);
    out.sort();
    out
}

fn with_ext(name: &str, ext: &str) -> String {
    match name.rfind('.') {
        Some(dot) => format!("{}.{ext}", &name[..dot]),
        None => format!("{name}.{ext}"),
    }
}

/// meta.json with the tile type the archive carries
fn patched_meta(path: &Path, patch: &[(&str, serde_json::Value)]) -> Result<Vec<u8>, String> {
    let text = fs::read_to_string(path).map_err(|_| format!("Cache-Datei fehlt: {}", path.display()))?;
    let mut meta: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    for (key, value) in patch {
        meta[*key] = value.clone();
    }
    serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())
}

struct Writer<W: Write + std::io::Seek> {
    zip: ZipWriter<W>,
    tiles: usize,
    tile_bytes: u64,
}

impl<W: Write + std::io::Seek> Writer<W> {
    fn put(&mut self, name: &str, bytes: &[u8], compress: bool) -> Result<(), String> {
        let method = if compress { CompressionMethod::Deflated } else { CompressionMethod::Stored };
        let options = SimpleFileOptions::default().compression_method(method).large_file(bytes.len() as u64 >= u32::MAX as u64);
        self.zip.start_file(name, options).map_err(|e| e.to_string())?;
        self.zip.write_all(bytes).map_err(|e| e.to_string())
    }

    fn put_file(&mut self, name: &str, path: &Path, compress: bool) -> Result<(), String> {
        let bytes = fs::read(path).map_err(|_| format!("Cache-Datei fehlt: {}", path.display()))?;
        self.put(name, &bytes, compress)
    }

    /// every tile below `dir` as WebP under `prefix`, encoded in parallel batches
    fn put_tiles(&mut self, prefix: &str, dir: &Path, encoding: TileEncoding, progress: &dyn Fn(f32)) -> Result<(), String> {
        let list = files_below(dir);
        let total = list.len().max(1);
        for (done, batch) in list.chunks(512).enumerate() {
            progress((done * 512) as f32 / total as f32);
            let encoded: Vec<(String, Vec<u8>)> = batch
                .par_iter()
                .map(|(name, path)| {
                    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
                    Ok((format!("{prefix}/{}", with_ext(name, "webp")), tiles::to_webp(&bytes, encoding)?))
                })
                .collect::<Result<_, String>>()?;
            for (name, bytes) in encoded {
                self.tile_bytes += bytes.len() as u64;
                self.tiles += 1;
                self.put(&name, &bytes, false)?;
            }
        }
        Ok(())
    }
}

/// A 16-bit raster from the cache (little-endian) as a greyscale PNG. PNG's row predictors suit
/// terrain far better than plain deflate: lossless, and a fraction of the raw size. `signed` values
/// (the i16 grid) are shifted into the unsigned range.
fn png16(raw: &[u8], width: usize, height: usize, signed: bool) -> Result<Vec<u8>, String> {
    if raw.len() != width * height * 2 {
        return Err("Der Gelände-Cache ist unvollständig.".into());
    }
    let values: Vec<u8> = raw
        .chunks_exact(2)
        .flat_map(|p| {
            let v = u16::from_le_bytes([p[0], p[1]]);
            (if signed { v ^ 0x8000 } else { v }).to_ne_bytes()
        })
        .collect();
    let mut out = Vec::with_capacity(raw.len() / 2);
    image::codecs::png::PngEncoder::new_with_quality(&mut out, image::codecs::png::CompressionType::Default, image::codecs::png::FilterType::Adaptive)
        .write_image(&values, width as u32, height as u32, image::ExtendedColorType::L16)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// the inverse of `png16`: little-endian bytes as the cache keeps them
fn unpng16(bytes: &[u8], signed: bool) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory(bytes).map_err(|e| format!("Raster im Archiv unlesbar: {e}"))?;
    let image::DynamicImage::ImageLuma16(buffer) = image else { return Err("Raster im Archiv hat das falsche Format.".into()) };
    Ok(buffer.into_raw().iter().flat_map(|&v| (if signed { v ^ 0x8000 } else { v }).to_le_bytes()).collect())
}

pub fn write(options: &SaveOptions, cache_root: &Path, out: &Path, progress: &dyn Fn(&str, f32)) -> Result<SaveReport, String> {
    let terrain_dir = options.terrain_id.as_ref().map(|id| heightmap::cache_dir(cache_root, id));
    let raw_heights = terrain_dir.as_ref().map(|d| d.join("heights.u16")).filter(|p| p.exists());
    let full_heights = options.heights != "none" && raw_heights.is_some();
    let (created_at, nanos) = now();
    let manifest = Manifest {
        format: "veilmap".into(),
        version: 1,
        stamp: format!("{nanos:x}"),
        created_at,
        terrain: options.terrain_id.clone(),
        koppen: options.koppen_id.clone(),
        satellite: options.satellite_id.clone(),
        images: options.image_ids.clone(),
        full_heights,
        quality: options.tiles.quality,
        lossless: options.tiles.lossless,
    };

    let file = fs::File::create(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let mut w = Writer { zip: ZipWriter::new(BufWriter::new(file)), tiles: 0, tile_bytes: 0 };
    w.put(MANIFEST, &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?, true)?;
    w.put(PROJECT, options.project.as_bytes(), true)?;

    let mut heights_bytes = 0u64;
    if let (Some(id), Some(dir)) = (&options.terrain_id, &terrain_dir) {
        let prefix = format!("terrain/{id}");
        let meta: heightmap::TerrainMeta =
            serde_json::from_str(&fs::read_to_string(dir.join("meta.json")).map_err(|_| "Cache-Datei fehlt: meta.json".to_string())?).map_err(|e| e.to_string())?;
        // heights already halved on an earlier device stay as they are
        let half = options.heights == "half" && meta.heights_width.unwrap_or(meta.width) == meta.width;
        let (heights_width, heights_height) = if half { (meta.width / 2, meta.height / 2) } else { (meta.heights_width.unwrap_or(meta.width), meta.heights_height.unwrap_or(meta.height)) };
        let meta_bytes = patched_meta(
            &dir.join("meta.json"),
            &[
                ("tileExt", "webp".into()),
                ("fullHeights", full_heights.into()),
                ("heightsWidth", heights_width.into()),
                ("heightsHeight", heights_height.into()),
            ],
        )?;
        let grid = fs::read(dir.join("grid.i16")).map_err(|_| "Cache-Datei fehlt: grid.i16".to_string())?;
        w.put(&format!("{prefix}/grid.png"), &png16(&grid, meta.grid_width, meta.grid_height, true)?, false)?;
        w.put_file(&format!("{prefix}/land.json"), &dir.join("land.json"), true)?;
        for (i, kind) in ["relief", "shade"].iter().enumerate() {
            w.put_tiles(&format!("{prefix}/tiles/{kind}"), &dir.join("tiles").join(kind), options.tiles, &|f| {
                progress(if i == 0 { "Reliefkacheln komprimieren" } else { "Schummerungskacheln komprimieren" }, 0.02 + 0.28 * (i as f32 + f))
            })?;
        }
        if full_heights {
            progress("Höhen verlustfrei packen", 0.6);
            let raw = fs::read(raw_heights.as_ref().unwrap()).map_err(|e| e.to_string())?;
            let (w0, h0) = (meta.heights_width.unwrap_or(meta.width), meta.heights_height.unwrap_or(meta.height));
            let png = if half {
                let (halved, w, h) = halve_heights(&raw, w0, h0);
                png16(&halved, w, h, false)?
            } else {
                png16(&raw, w0, h0, false)?
            };
            heights_bytes = png.len() as u64;
            w.put(&format!("{prefix}/heights.png"), &png, false)?;
        }
        // meta.json goes last so an interrupted unpack never looks complete
        w.put(&format!("{prefix}/meta.json"), &meta_bytes, true)?;
    }
    if let Some(id) = &options.koppen_id {
        let dir = cache_root.join("koppen").join(id);
        w.put_file(&format!("koppen/{id}/classes.u8"), &dir.join("classes.u8"), true)?;
        w.put_file(&format!("koppen/{id}/meta.json"), &dir.join("meta.json"), true)?;
    }
    // the satellite picture and the image layers share one cache format; each is written once
    let mut pictures: Vec<&String> = Vec::new();
    for id in options.satellite_id.iter().chain(options.image_ids.iter()) {
        if !pictures.contains(&id) {
            pictures.push(id);
        }
    }
    let share = 0.28 / pictures.len().max(1) as f32;
    for (i, id) in pictures.iter().enumerate() {
        let dir = crate::satellite::cache_dir(cache_root, id);
        let prefix = format!("satellite/{id}");
        let stage = if Some(*id) == options.satellite_id.as_ref() { "Satellitenbild komprimieren" } else { "Bildebenen komprimieren" };
        w.put_tiles(&format!("{prefix}/tiles"), &dir.join("tiles"), options.tiles, &|f| progress(stage, 0.7 + share * (i as f32 + f)))?;
        w.put(&format!("{prefix}/meta.json"), &patched_meta(&dir.join("meta.json"), &[("tileExt", "webp".into())])?, true)?;
    }
    let (tiles, tile_bytes) = (w.tiles, w.tile_bytes);
    let mut inner = w.zip.finish().map_err(|e| e.to_string())?;
    inner.flush().map_err(|e| e.to_string())?;
    drop(inner);
    let bytes = fs::metadata(out).map(|m| m.len()).unwrap_or(0);
    progress("Fertig", 1.0);
    Ok(SaveReport { bytes, tiles, tile_bytes, heights_bytes, full_heights })
}

/// A cache folder is taken as it is when it is an original import (no stamp) or was unpacked from
/// this very archive; anything else is replaced.
fn cached_and_current(dir: &Path, stamp: &str) -> bool {
    if !dir.join("meta.json").exists() {
        return false;
    }
    match fs::read_to_string(dir.join(STAMP)) {
        Ok(existing) => existing.trim() == stamp,
        Err(_) => true,
    }
}

/// Reads a .veil (JSON) or a .veilmap (ZIP). An archive is unpacked into the cache first.
pub fn open(path: &Path, cache_root: &Path, progress: &dyn Fn(&str, f32)) -> Result<Opened, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut head = [0u8; 4];
    let read = file.read(&mut head).map_err(|e| e.to_string())?;
    if !is_zip(&head[..read]) {
        let project = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        return Ok(Opened { project, archive: false, unpacked: Vec::new() });
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| format!("Archiv beschädigt: {e}"))?;
    let read_text = |zip: &mut ZipArchive<_>, name: &str| -> Result<String, String> {
        let mut entry = zip.by_name(name).map_err(|_| format!("Archiv unvollständig: {name} fehlt"))?;
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(|e| e.to_string())?;
        Ok(text)
    };
    let manifest: Manifest = serde_json::from_str(&read_text(&mut zip, MANIFEST)?).map_err(|e| format!("Kein VEIL-Archiv: {e}"))?;
    if manifest.format != "veilmap" {
        return Err("Kein VEIL-Archiv.".into());
    }
    let project = read_text(&mut zip, PROJECT)?;

    let mut unpacked = Vec::new();
    let mut parts: Vec<(&str, String)> = PARTS
        .iter()
        .zip([&manifest.terrain, &manifest.koppen, &manifest.satellite])
        .filter_map(|(kind, id)| id.clone().map(|id| (*kind, id)))
        .collect();
    for id in &manifest.images {
        if !parts.iter().any(|(kind, existing)| *kind == "satellite" && existing == id) {
            parts.push(("satellite", id.clone()));
        }
    }
    for (index, (kind, id)) in parts.iter().enumerate() {
        if id.is_empty() || id.contains(['/', '\\', '.']) {
            return Err(format!("Ungültige Kennung im Archiv: {id}"));
        }
        let dir = cache_root.join(kind).join(id);
        if cached_and_current(&dir, &manifest.stamp) {
            continue;
        }
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::write(dir.join(STAMP), &manifest.stamp).map_err(|e| e.to_string())?;
        let prefix = format!("{kind}/{id}/");
        let names: Vec<String> = zip.file_names().filter(|n| n.starts_with(&prefix)).map(String::from).collect();
        let total = names.len().max(1);
        let mut meta_json = None;
        for (i, name) in names.iter().enumerate() {
            if i % 256 == 0 {
                progress(&format!("Archiv entpacken ({kind})"), (index as f32 + i as f32 / total as f32) / parts.len() as f32);
            }
            let mut entry = zip.by_name(name).map_err(|e| e.to_string())?;
            let Some(relative) = entry.enclosed_name() else { return Err(format!("Ungültiger Pfad im Archiv: {name}")) };
            let target = cache_root.join(relative);
            if !target.starts_with(&dir) {
                return Err(format!("Ungültiger Pfad im Archiv: {name}"));
            }
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            if name.ends_with("/meta.json") && target.parent() == Some(dir.as_path()) {
                meta_json = Some(bytes);
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if *kind == "terrain" && target.parent() == Some(dir.as_path()) && name.ends_with(".png") {
                let (file, signed) = if name.ends_with("/grid.png") { ("grid.i16", true) } else { ("heights.u16", false) };
                progress("Höhen auspacken", (index as f32 + 0.9) / parts.len() as f32);
                fs::write(dir.join(file), unpng16(&bytes, signed)?).map_err(|e| e.to_string())?;
                continue;
            }
            fs::write(&target, &bytes).map_err(|e| e.to_string())?;
        }
        let Some(meta) = meta_json else { return Err(format!("Archiv unvollständig: {kind}/{id}/meta.json fehlt")) };
        fs::write(dir.join("meta.json"), meta).map_err(|e| e.to_string())?;
        unpacked.push(kind.to_string());
    }
    progress("Fertig", 1.0);
    Ok(Opened { project, archive: true, unpacked })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::heightmap::{build_cache, run_checks, ImportOptions};

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("veil-archive-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// a small 2:1 heightmap in our encoding: one continent in an ocean
    fn write_heightmap(path: &Path) {
        let (w, h) = (1024u32, 512u32);
        let image = image::ImageBuffer::<image::Luma<u16>, Vec<u16>>::from_fn(w, h, |x, y| {
            let dx = (x as f32 - 512.0) / 300.0;
            let dy = (y as f32 - 256.0) / 150.0;
            let m = 3000.0 * (1.0 - (dx * dx + dy * dy)) - 1000.0 + ((x as f32 * 0.07).sin() * (y as f32 * 0.05).cos()) * 300.0;
            image::Luma([heightmap::encode(m.max(-5000.0))])
        });
        image.save(path).unwrap();
    }

    #[test]
    fn round_trip_through_a_second_cache() {
        let pc = temp("pc");
        let source = pc.join("height.png");
        write_heightmap(&source);
        let options = ImportOptions { path: source.to_string_lossy().into(), crop_square: false, control_points: vec![] };
        let (_, _, map) = run_checks(&options);
        let map = map.unwrap();
        let meta = build_cache(&map, &options, "abc123", 6_606_727.0, &pc, &|_, _| {}).unwrap();

        let out = pc.join("world.veilmap");
        let save = SaveOptions {
            project: "{\"format\":\"veil-project\"}".into(),
            terrain_id: Some(meta.id.clone()),
            koppen_id: None,
            satellite_id: None,
            image_ids: vec![],
            tiles: TileEncoding { quality: 80.0, lossless: false },
            heights: "full".into(),
        };
        let report = write(&save, &pc, &out, &|_, _| {}).unwrap();
        assert!(report.full_heights);
        assert!(report.tiles > 0);

        // another device: empty cache
        let tablet = temp("tablet");
        let opened = open(&out, &tablet, &|_, _| {}).unwrap();
        assert!(opened.archive);
        assert_eq!(opened.project, save.project);
        assert_eq!(opened.unpacked, vec!["terrain".to_string()]);
        let (tablet_meta, tablet_map) = heightmap::load_cached(&tablet, &meta.id).unwrap();
        assert_eq!(tablet_meta.tile_ext, "webp");
        assert_eq!(tablet_map.data, map.data, "heights must survive losslessly");
        assert!(heightmap::cache_dir(&tablet, &meta.id).join("tiles/relief/0/0/0.webp").exists());

        // opening the same archive again leaves the cache alone
        assert!(open(&out, &tablet, &|_, _| {}).unwrap().unpacked.is_empty());
        // the PC's own cache is an original import and stays as it is
        assert!(open(&out, &pc, &|_, _| {}).unwrap().unpacked.is_empty());

        // without full heights the grid answers
        let lean = pc.join("lean.veilmap");
        write(&SaveOptions { heights: "none".into(), ..save }, &pc, &lean, &|_, _| {}).unwrap();
        let (lean_meta, lean_map) = heightmap::load_cached(&{
            let phone = temp("phone");
            open(&lean, &phone, &|_, _| {}).unwrap();
            phone
        }, &meta.id)
        .unwrap();
        assert!(!lean_meta.full_heights);
        assert_eq!(lean_map.width, lean_meta.grid_width);
        let exact = map.sample(0.0, 0.0);
        assert!((lean_map.sample(0.0, 0.0) - exact).abs() < 60.0);

        // a re-save on the tablet passes the WebP tiles through unchanged
        let again = tablet.join("again.veilmap");
        let resave = SaveOptions {
            project: "{}".into(),
            terrain_id: Some(meta.id.clone()),
            koppen_id: None,
            satellite_id: None,
            image_ids: vec![],
            tiles: TileEncoding { quality: 10.0, lossless: false },
            heights: "full".into(),
        };
        write(&resave, &tablet, &again, &|_, _| {}).unwrap();
        let mut a = ZipArchive::new(fs::File::open(&out).unwrap()).unwrap();
        let mut b = ZipArchive::new(fs::File::open(&again).unwrap()).unwrap();
        let name = format!("terrain/{}/tiles/relief/1/1/0.webp", meta.id);
        let read = |z: &mut ZipArchive<fs::File>| {
            let mut v = Vec::new();
            z.by_name(&name).unwrap().read_to_end(&mut v).unwrap();
            v
        };
        assert_eq!(read(&mut a), read(&mut b));

        // half resolution: a quarter of the samples, close to the full heights
        let half = pc.join("half.veilmap");
        let half_save = SaveOptions {
            project: "{}".into(),
            terrain_id: Some(meta.id.clone()),
            koppen_id: None,
            satellite_id: None,
            image_ids: vec![],
            tiles: TileEncoding { quality: 80.0, lossless: false },
            heights: "half".into(),
        };
        write(&half_save, &pc, &half, &|_, _| {}).unwrap();
        let laptop = temp("laptop");
        open(&half, &laptop, &|_, _| {}).unwrap();
        let (_, half_map) = heightmap::load_cached(&laptop, &meta.id).unwrap();
        assert_eq!((half_map.width, half_map.height), (map.width / 2, map.height / 2));
        assert!((half_map.sample(10.0, 5.0) - map.sample(10.0, 5.0)).abs() < 40.0);
        // and saved once more from there, the halved heights are not halved again
        let again_half = laptop.join("again.veilmap");
        write(&half_save, &laptop, &again_half, &|_, _| {}).unwrap();
        let tablet2 = temp("tablet2");
        open(&again_half, &tablet2, &|_, _| {}).unwrap();
        assert_eq!(heightmap::load_cached(&tablet2, &meta.id).unwrap().1.width, map.width / 2);
    }

    #[test]
    fn image_layers_travel_with_their_transparency() {
        let pc = temp("images-pc");
        let source = pc.join("borders.png");
        // a 2:1 overlay: a red band on a transparent world
        image::RgbaImage::from_fn(1024, 512, |_, y| if (200..260).contains(&y) { image::Rgba([220, 30, 30, 255]) } else { image::Rgba([0, 0, 0, 0]) })
            .save(&source)
            .unwrap();
        let meta = crate::satellite::import(&crate::satellite::SatelliteOptions { path: source.to_string_lossy().into(), crop_square: false }, &pc, &|_, _| {}).unwrap();
        assert!(meta.alpha);
        let out = pc.join("layers.veilmap");
        let save = SaveOptions {
            project: "{}".into(),
            terrain_id: None,
            koppen_id: None,
            satellite_id: None,
            image_ids: vec![meta.id.clone(), meta.id.clone()],
            tiles: TileEncoding { quality: 85.0, lossless: false },
            heights: "none".into(),
        };
        let report = write(&save, &pc, &out, &|_, _| {}).unwrap();
        assert_eq!(report.tiles, 8 + 2, "each layer is written once");

        let tablet = temp("images-tablet");
        let opened = open(&out, &tablet, &|_, _| {}).unwrap();
        assert_eq!(opened.unpacked, vec!["satellite".to_string()]);
        let dir = crate::satellite::cache_dir(&tablet, &meta.id);
        let tile = image::open(dir.join("tiles/1/0/0.webp")).unwrap().to_rgba8();
        assert!(tile.get_pixel(10, 10)[3] < 10, "outside the band stays transparent");
        assert!(tile.get_pixel(10, 230)[3] > 245);
        let unpacked: crate::satellite::SatelliteMeta = serde_json::from_str(&fs::read_to_string(dir.join("meta.json")).unwrap()).unwrap();
        assert_eq!(unpacked.tile_ext, "webp");
    }

    #[test]
    fn plain_project_files_are_read_as_text() {
        let dir = temp("plain");
        let path = dir.join("p.veil");
        fs::write(&path, "{\"format\":\"veil-project\"}").unwrap();
        let opened = open(&path, &dir, &|_, _| {}).unwrap();
        assert!(!opened.archive);
    }
}
