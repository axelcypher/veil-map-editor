// Heightmap import: check the Gaea/Photoshop export against our encoding, then derive everything
// the editor shows from it (tiles, a coarse grid, coast polygons). The terrain itself is read-only.
use crate::coast;
use crate::raster::{self, Gray16, SourceInfo};
use image::{GrayImage, ImageEncoder, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const TILE: usize = 256;
pub const GRID_WIDTH: usize = 4096;
pub const COAST_WIDTH: usize = 8192;

/// file value (0..65535) to metres: PS shows 0..32768, one PS step is one metre, sea level at 16384
#[inline]
pub fn meters(value: u16) -> f32 {
    value as f32 * 32768.0 / 65535.0 - 16384.0
}

pub struct Heightmap {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u16>,
}

impl Heightmap {
    #[inline]
    fn at(&self, x: isize, y: isize) -> f32 {
        let x = x.rem_euclid(self.width as isize) as usize;
        let y = y.clamp(0, self.height as isize - 1) as usize;
        meters(self.data[y * self.width + x])
    }

    /// bilinear height in metres at a geographic position
    pub fn sample(&self, lon: f64, lat: f64) -> f32 {
        let x = (lon + 180.0) / 360.0 * self.width as f64 - 0.5;
        let y = (90.0 - lat) / 180.0 * self.height as f64 - 0.5;
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = ((x - x0) as f32, (y - y0) as f32);
        let (x0, y0) = (x0 as isize, y0 as isize);
        let top = self.at(x0, y0) * (1.0 - fx) + self.at(x0 + 1, y0) * fx;
        let bottom = self.at(x0, y0 + 1) * (1.0 - fx) + self.at(x0 + 1, y0 + 1) * fx;
        top * (1.0 - fy) + bottom * fy
    }
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ControlPoint {
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    /// "height": expected ± tolerance, "sea": below 0, "land": above 0
    pub kind: String,
    #[serde(default)]
    pub expected: f32,
    #[serde(default = "default_tolerance")]
    pub tolerance: f32,
}

fn default_tolerance() -> f32 {
    100.0
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub path: String,
    #[serde(default)]
    pub crop_square: bool,
    #[serde(default)]
    pub control_points: Vec<ControlPoint>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Check {
    pub label: String,
    /// "ok", "warn" or "error"
    pub status: String,
    pub detail: String,
}

fn check(label: &str, status: &str, detail: impl Into<String>) -> Check {
    Check { label: label.into(), status: status.into(), detail: detail.into() }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TerrainMeta {
    pub id: String,
    pub source: String,
    pub hash: String,
    pub width: usize,
    pub height: usize,
    pub crop_square: bool,
    pub max_zoom: u32,
    pub tile_size: usize,
    pub grid_width: usize,
    pub grid_height: usize,
    pub min_m: f32,
    pub max_m: f32,
    pub sea_fraction: f32,
    pub created_at: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub ok: bool,
    pub source: Option<SourceInfo>,
    pub checks: Vec<Check>,
    pub meta: Option<TerrainMeta>,
}

struct Stats {
    raw_min: u16,
    raw_max: u16,
    sea_fraction: f32,
}

fn stats(data: &[u16]) -> Stats {
    let sea_raw = 32767u16; // meters(32767) < 0 < meters(32768)
    let (raw_min, raw_max, sea) = data
        .par_chunks(1 << 20)
        .map(|chunk| {
            let mut lo = u16::MAX;
            let mut hi = 0u16;
            let mut sea = 0usize;
            for &v in chunk {
                lo = lo.min(v);
                hi = hi.max(v);
                if v <= sea_raw {
                    sea += 1;
                }
            }
            (lo, hi, sea)
        })
        .reduce(|| (u16::MAX, 0, 0), |a, b| (a.0.min(b.0), a.1.max(b.1), a.2 + b.2));
    Stats { raw_min, raw_max, sea_fraction: sea as f32 / data.len().max(1) as f32 }
}

/// Every rule from the vault note: 2:1, 16 bit, our encoding, sea level at known points.
/// Errors stop the import; warnings are shown and the import continues.
pub fn run_checks(options: &ImportOptions) -> (Vec<Check>, Option<SourceInfo>, Option<Heightmap>) {
    let mut checks = Vec::new();
    let path = Path::new(&options.path);
    let (gray, info) = match raster::read_gray16(path) {
        Ok(result) => result,
        Err(message) => {
            checks.push(check("Format", "error", message));
            return (checks, None, None);
        }
    };
    checks.push(check(
        "Format",
        "ok",
        format!("{} · {} × {} px · 16 Bit Graustufen", info.format, info.width, info.height),
    ));
    let Gray16 { mut width, mut height, mut data } = gray;
    if options.crop_square && width == height {
        match raster::crop_square_middle(&data, width, height) {
            Ok((cropped, w, h)) => {
                data = cropped;
                width = w;
                height = h;
                checks.push(check("Zuschnitt", "ok", format!("Mitte ausgeschnitten: {width} × {height} px")));
            }
            Err(message) => checks.push(check("Zuschnitt", "error", message)),
        }
    }
    match raster::check_ratio(width, height) {
        Ok(()) => checks.push(check("Seitenverhältnis", "ok", format!("2:1 ({width} × {height} px)"))),
        Err(message) => {
            checks.push(check("Seitenverhältnis", "error", message));
            return (checks, Some(info), None);
        }
    }

    let s = stats(&data);
    if s.raw_min == 0 && s.raw_max == 65535 {
        checks.push(check(
            "Höhenkodierung",
            "error",
            "Die Datei nutzt den vollen Wertebereich 0 … 65.535. Das sieht nach einem normalisierten Export aus; Gaea muss ohne Normalisierung exportieren.",
        ));
    } else {
        let (lo, hi) = (meters(s.raw_min), meters(s.raw_max));
        let status = if lo < -12001.0 || hi > 9001.0 { "warn" } else { "ok" };
        let note = if status == "warn" { " – außerhalb der Gestaltungsgrenzen −12.000 … +9.000 m" } else { "" };
        checks.push(check("Höhenkodierung", status, format!("{lo:.0} m … {hi:.0} m{note}")));
    }
    let sea_pct = s.sea_fraction * 100.0;
    let sea_status = if (15.0..=95.0).contains(&sea_pct) { "ok" } else { "warn" };
    checks.push(check(
        "Meeresanteil",
        sea_status,
        format!("{sea_pct:.1} % unter dem Meeresspiegel{}", if sea_status == "warn" { " – Kodierung oder Invertierung prüfen" } else { "" }),
    ));

    let map = Heightmap { width, height, data };

    // the seam at ±180° has to lie in the sea; the polar caps are painted as their own regions
    let mut seam_land = 0usize;
    let mut seam_total = 0usize;
    for y in 0..height {
        let lat = 90.0 - (y as f64 + 0.5) / height as f64 * 180.0;
        if lat.abs() > 75.0 {
            continue;
        }
        for x in [0, width - 1] {
            seam_total += 1;
            if meters(map.data[y * width + x]) > 0.0 {
                seam_land += 1;
            }
        }
    }
    if seam_land == 0 {
        checks.push(check("Naht ±180°", "ok", "liegt zwischen 75° N und 75° S im Meer"));
    } else {
        checks.push(check(
            "Naht ±180°",
            "warn",
            format!("{seam_land} von {seam_total} Randpixeln liegen über dem Meeresspiegel"),
        ));
    }

    if options.control_points.is_empty() {
        checks.push(check(
            "Kontrollpunkte",
            "warn",
            "Keine Kontrollpunkte angelegt – der Meeresspiegel wird nicht an bekannten Punkten geprüft.",
        ));
    }
    for point in &options.control_points {
        let actual = map.sample(point.lon, point.lat);
        let (ok, expectation) = match point.kind.as_str() {
            "sea" => (actual < 0.0, "Meer (< 0 m)".to_string()),
            "land" => (actual > 0.0, "Land (> 0 m)".to_string()),
            _ => (
                (actual - point.expected).abs() <= point.tolerance,
                format!("{:.0} ± {:.0} m", point.expected, point.tolerance),
            ),
        };
        checks.push(check(
            &format!("Punkt „{}“", point.name),
            if ok { "ok" } else { "error" },
            format!("erwartet {expectation}, gemessen {actual:.0} m ({:.3}°, {:.3}°)", point.lon, point.lat),
        ));
    }
    (checks, Some(info), Some(map))
}

// ---------------------------------------------------------------------------------------------
// derived data

struct Level<'a> {
    width: usize,
    height: usize,
    raw: Option<&'a [u16]>,
    values: Vec<f32>,
}

impl Level<'_> {
    #[inline]
    fn at(&self, x: isize, y: isize) -> f32 {
        let x = x.rem_euclid(self.width as isize) as usize;
        let y = y.clamp(0, self.height as isize - 1) as usize;
        match self.raw {
            Some(raw) => meters(raw[y * self.width + x]),
            None => self.values[y * self.width + x],
        }
    }

    fn halve(&self) -> Level<'static> {
        let (width, height) = (self.width / 2, self.height / 2);
        let mut values = vec![0f32; width * height];
        values.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
            for (x, out) in row.iter_mut().enumerate() {
                let (sx, sy) = (x as isize * 2, y as isize * 2);
                *out = (self.at(sx, sy) + self.at(sx + 1, sy) + self.at(sx, sy + 1) + self.at(sx + 1, sy + 1)) * 0.25;
            }
        });
        Level { width, height, raw: None, values }
    }
}

fn resample_u16(source: &Heightmap, width: usize, height: usize) -> Vec<u16> {
    let mut out = vec![0u16; width * height];
    out.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        let lat = 90.0 - (y as f64 + 0.5) / height as f64 * 180.0;
        for (x, value) in row.iter_mut().enumerate() {
            let lon = (x as f64 + 0.5) / width as f64 * 360.0 - 180.0;
            let m = source.sample(lon, lat);
            *value = ((m + 16384.0) * 65535.0 / 32768.0).round().clamp(0.0, 65535.0) as u16;
        }
    });
    out
}

const LAND_RAMP: &[(f32, [f32; 3])] = &[
    (0.0, [104.0, 146.0, 92.0]),
    (150.0, [122.0, 160.0, 98.0]),
    (500.0, [160.0, 176.0, 110.0]),
    (1000.0, [196.0, 186.0, 128.0]),
    (1800.0, [186.0, 156.0, 112.0]),
    (2800.0, [160.0, 128.0, 104.0]),
    (3800.0, [168.0, 156.0, 150.0]),
    (5000.0, [225.0, 224.0, 222.0]),
    (9000.0, [255.0, 255.0, 255.0]),
];
const SEA_RAMP: &[(f32, [f32; 3])] = &[
    (-11000.0, [10.0, 28.0, 66.0]),
    (-6000.0, [20.0, 52.0, 104.0]),
    (-3500.0, [34.0, 80.0, 142.0]),
    (-1500.0, [56.0, 114.0, 176.0]),
    (-200.0, [100.0, 160.0, 206.0]),
    (0.0, [150.0, 198.0, 224.0]),
];

fn ramp(table: &[(f32, [f32; 3])], h: f32) -> [f32; 3] {
    if h <= table[0].0 {
        return table[0].1;
    }
    for pair in table.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if h <= b.0 {
            let t = (h - a.0) / (b.0 - a.0);
            return [a.1[0] + (b.1[0] - a.1[0]) * t, a.1[1] + (b.1[1] - a.1[1]) * t, a.1[2] + (b.1[2] - a.1[2]) * t];
        }
    }
    table[table.len() - 1].1
}

/// Horn hillshade from the NW at 45°; 1.0 is a surface facing the light, ~0.71 flat ground
#[inline]
fn hillshade(level: &Level, x: isize, y: isize, dx: f32, dy: f32, exaggeration: f32) -> f32 {
    let a = level.at(x - 1, y - 1);
    let b = level.at(x, y - 1);
    let c = level.at(x + 1, y - 1);
    let d = level.at(x - 1, y);
    let f = level.at(x + 1, y);
    let g = level.at(x - 1, y + 1);
    let h = level.at(x, y + 1);
    let i = level.at(x + 1, y + 1);
    let dzdx = ((c + 2.0 * f + i) - (a + 2.0 * d + g)) / (8.0 * dx) * exaggeration;
    let dzdy = ((g + 2.0 * h + i) - (a + 2.0 * b + c)) / (8.0 * dy) * exaggeration;
    let slope = (dzdx * dzdx + dzdy * dzdy).sqrt().atan();
    let aspect = dzdy.atan2(-dzdx);
    let zenith = 45f32.to_radians();
    let azimuth = 135f32.to_radians(); // 315° compass in the maths convention
    (zenith.cos() * slope.cos() + zenith.sin() * slope.sin() * (azimuth - aspect).cos()).max(0.0)
}

fn write_png_rgb(path: &Path, image: &RgbImage) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|e| e.to_string())?;
    let encoder = image::codecs::png::PngEncoder::new_with_quality(
        std::io::BufWriter::new(file),
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::Sub,
    );
    encoder
        .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())
}

fn write_png_gray(path: &Path, image: &GrayImage) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|e| e.to_string())?;
    let encoder = image::codecs::png::PngEncoder::new_with_quality(
        std::io::BufWriter::new(file),
        image::codecs::png::CompressionType::Fast,
        image::codecs::png::FilterType::Sub,
    );
    encoder
        .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::L8)
        .map_err(|e| e.to_string())
}

fn render_level(level: &Level, z: u32, max_zoom: u32, radius: f64, dir: &Path) -> Result<(), String> {
    let tiles_x = level.width / TILE;
    let tiles_y = level.height / TILE;
    // coarse levels flatten the relief, so they get more exaggeration
    let exaggeration = 4.0 * 1.45f32.powi((max_zoom - z) as i32);
    let dy = (std::f64::consts::PI * radius / level.height as f64) as f32;
    for kind in ["relief", "shade"] {
        for tx in 0..tiles_x {
            fs::create_dir_all(dir.join(kind).join(z.to_string()).join(tx.to_string())).map_err(|e| e.to_string())?;
        }
    }
    (0..tiles_x * tiles_y).into_par_iter().try_for_each(|index| -> Result<(), String> {
        let (tx, ty) = (index % tiles_x, index / tiles_x);
        let mut relief = RgbImage::new(TILE as u32, TILE as u32);
        let mut shade = GrayImage::new(TILE as u32, TILE as u32);
        for py in 0..TILE {
            let y = (ty * TILE + py) as isize;
            let lat = 90.0 - (y as f64 + 0.5) / level.height as f64 * 180.0;
            let dx = ((2.0 * std::f64::consts::PI * radius * lat.to_radians().cos().max(0.02)) / level.width as f64) as f32;
            for px in 0..TILE {
                let x = (tx * TILE + px) as isize;
                let h = level.at(x, y);
                let s = hillshade(level, x, y, dx, dy, exaggeration);
                let lit = (s / 0.7071).min(1.35);
                let (color, light) = if h > 0.0 {
                    (ramp(LAND_RAMP, h), 0.45 + 0.55 * lit)
                } else {
                    (ramp(SEA_RAMP, h), 0.88 + 0.12 * lit)
                };
                relief.put_pixel(
                    px as u32,
                    py as u32,
                    image::Rgb([
                        (color[0] * light).clamp(0.0, 255.0) as u8,
                        (color[1] * light).clamp(0.0, 255.0) as u8,
                        (color[2] * light).clamp(0.0, 255.0) as u8,
                    ]),
                );
                let gray = if h > 0.0 { (238.0 * lit.min(1.07)).clamp(0.0, 255.0) } else { 255.0 };
                shade.put_pixel(px as u32, py as u32, image::Luma([gray as u8]));
            }
        }
        let name = format!("{ty}.png");
        write_png_rgb(&dir.join("relief").join(z.to_string()).join(tx.to_string()).join(&name), &relief)?;
        write_png_gray(&dir.join("shade").join(z.to_string()).join(tx.to_string()).join(&name), &shade)?;
        Ok(())
    })
}

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn cache_dir(cache_root: &Path, id: &str) -> PathBuf {
    cache_root.join("terrain").join(id)
}

/// Writes tiles, the coarse grid, the coast polygons and the raw heights into the cache.
pub fn build_cache(
    map: &Heightmap,
    options: &ImportOptions,
    hash: &str,
    radius: f64,
    cache_root: &Path,
    progress: &dyn Fn(&str, f32),
) -> Result<TerrainMeta, String> {
    let id = format!("{hash}{}", if options.crop_square { "-c" } else { "" });
    let dir = cache_dir(cache_root, &id);
    let meta_path = dir.join("meta.json");
    if let Ok(text) = fs::read_to_string(&meta_path) {
        if let Ok(meta) = serde_json::from_str::<TerrainMeta>(&text) {
            return Ok(meta);
        }
    }
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    progress("Höhen speichern", 0.02);
    {
        let mut file = std::io::BufWriter::new(fs::File::create(dir.join("heights.u16")).map_err(|e| e.to_string())?);
        let bytes: Vec<u8> = map.data.par_iter().flat_map_iter(|v| v.to_le_bytes()).collect();
        file.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    // the pyramid: level z is 512·2^z px wide; the top level has at least the source resolution
    let mut max_zoom = 0u32;
    while 512usize << max_zoom < map.width && max_zoom < 7 {
        max_zoom += 1;
    }
    let top_width = 512usize << max_zoom;
    let resampled;
    let top_raw: &[u16] = if top_width == map.width {
        &map.data
    } else {
        progress("Auf Kachelraster umrechnen", 0.05);
        resampled = resample_u16(map, top_width, top_width / 2);
        &resampled
    };
    let mut levels: Vec<Level> = vec![Level { width: top_width, height: top_width / 2, raw: Some(top_raw), values: Vec::new() }];
    for _ in 0..max_zoom {
        let next = levels.last().unwrap().halve();
        levels.push(next);
    }
    levels.reverse(); // index = zoom level

    let tiles_dir = dir.join("tiles");
    for (z, level) in levels.iter().enumerate() {
        progress("Kacheln rechnen", 0.1 + 0.6 * (z as f32 / (max_zoom + 1) as f32));
        render_level(level, z as u32, max_zoom, radius, &tiles_dir)?;
    }

    progress("Raster für Abfragen", 0.72);
    let grid_level = levels.iter().find(|l| l.width == GRID_WIDTH);
    let grid_height = GRID_WIDTH / 2;
    let mut grid = vec![0i16; GRID_WIDTH * grid_height];
    grid.par_chunks_mut(GRID_WIDTH).enumerate().for_each(|(y, row)| {
        for (x, out) in row.iter_mut().enumerate() {
            let m = match grid_level {
                Some(level) => level.at(x as isize, y as isize),
                None => {
                    let lon = (x as f64 + 0.5) / GRID_WIDTH as f64 * 360.0 - 180.0;
                    let lat = 90.0 - (y as f64 + 0.5) / grid_height as f64 * 180.0;
                    map.sample(lon, lat)
                }
            };
            *out = m.round().clamp(-32768.0, 32767.0) as i16;
        }
    });
    let grid_bytes: Vec<u8> = grid.iter().flat_map(|v| v.to_le_bytes()).collect();
    fs::write(dir.join("grid.i16"), grid_bytes).map_err(|e| e.to_string())?;

    progress("Küstenlinien", 0.8);
    let coast_level = levels.iter().find(|l| l.width == COAST_WIDTH).unwrap_or(levels.last().unwrap());
    let coast_values: Vec<f32> = (0..coast_level.width * coast_level.height)
        .into_par_iter()
        .map(|i| coast_level.at((i % coast_level.width) as isize, (i / coast_level.width) as isize))
        .collect();
    let land = coast::land_polygons(&coast_values, coast_level.width, coast_level.height, 0.0, 0.35, 1.5);
    fs::write(dir.join("land.json"), serde_json::to_string(&land).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;

    let s = stats(&map.data);
    let meta = TerrainMeta {
        id,
        source: options.path.clone(),
        hash: hash.to_string(),
        width: map.width,
        height: map.height,
        crop_square: options.crop_square,
        max_zoom,
        tile_size: TILE,
        grid_width: GRID_WIDTH,
        grid_height,
        min_m: meters(s.raw_min),
        max_m: meters(s.raw_max),
        sea_fraction: s.sea_fraction,
        created_at: now_secs(),
    };
    fs::write(&meta_path, serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    progress("Fertig", 1.0);
    Ok(meta)
}

pub fn load_cached(cache_root: &Path, id: &str) -> Result<(TerrainMeta, Heightmap), String> {
    let dir = cache_dir(cache_root, id);
    let meta: TerrainMeta = serde_json::from_str(
        &fs::read_to_string(dir.join("meta.json")).map_err(|_| "Kein Cache für dieses Gelände vorhanden.".to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let bytes = fs::read(dir.join("heights.u16")).map_err(|e| e.to_string())?;
    if bytes.len() != meta.width * meta.height * 2 {
        return Err("Der Gelände-Cache ist unvollständig.".into());
    }
    let data = bytes.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
    Ok((meta.clone(), Heightmap { width: meta.width, height: meta.height, data }))
}
