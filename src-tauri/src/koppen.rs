// Climate classes from a colour-coded Köppen map (World Orogen). Every pixel goes to the nearest
// palette colour within a tolerance; the result is a coarse class raster for display and queries.
use crate::heightmap::{Heightmap, GRID_WIDTH};
use crate::raster;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Deserialize, Debug, Clone)]
pub struct PaletteEntry {
    pub code: String,
    pub rgb: [u8; 3],
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KoppenOptions {
    pub path: String,
    pub palette: Vec<PaletteEntry>,
    /// largest RGB distance that still counts as a match
    pub tolerance: f32,
    #[serde(default)]
    pub crop_square: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KoppenMeta {
    pub id: String,
    pub source: String,
    pub hash: String,
    pub width: usize,
    pub height: usize,
    /// class codes in raster order; raster value 0 is "none", n is codes[n - 1]
    pub codes: Vec<String>,
    /// share of land pixels per code
    pub shares: HashMap<String, f32>,
    pub unmatched: f32,
    /// the most frequent colours that matched nothing, as hex, so the palette can be fixed
    pub unmatched_colors: Vec<(String, f32)>,
}

pub fn import(options: &KoppenOptions, terrain: Option<&Heightmap>, cache_root: &Path) -> Result<KoppenMeta, String> {
    let path = Path::new(&options.path);
    let (mut rgba, info) = raster::read_rgba8(path)?;
    let (mut width, mut height) = (info.width, info.height);
    if options.crop_square && width == height {
        let pixels: Vec<[u8; 4]> = rgba.chunks_exact(4).map(|p| [p[0], p[1], p[2], p[3]]).collect();
        let (cropped, w, h) = raster::crop_square_middle(&pixels, width, height)?;
        rgba = cropped.into_iter().flatten().collect();
        width = w;
        height = h;
    }
    raster::check_ratio(width, height)?;
    let hash = raster::file_hash(path)?;

    // nearest colour per distinct source colour; climate maps use only a few dozen
    let mut distinct: HashMap<u32, usize> = HashMap::new();
    for p in rgba.chunks_exact(4) {
        if p[3] < 128 {
            continue;
        }
        *distinct.entry(u32::from_be_bytes([0, p[0], p[1], p[2]])).or_default() += 1;
    }
    let tolerance2 = options.tolerance * options.tolerance;
    let classify = |key: u32| -> u8 {
        let [_, r, g, b] = key.to_be_bytes();
        let mut best = (f32::MAX, 0u8);
        for (i, entry) in options.palette.iter().enumerate() {
            let d = (r as f32 - entry.rgb[0] as f32).powi(2) + (g as f32 - entry.rgb[1] as f32).powi(2) + (b as f32 - entry.rgb[2] as f32).powi(2);
            if d < best.0 {
                best = (d, i as u8 + 1);
            }
        }
        if best.0 <= tolerance2 { best.1 } else { 0 }
    };
    let lookup: HashMap<u32, u8> = distinct.keys().map(|&k| (k, classify(k))).collect();
    let total: usize = distinct.values().sum();
    let mut unmatched_list: Vec<(u32, usize)> = distinct.iter().filter(|(k, _)| lookup[k] == 0).map(|(&k, &n)| (k, n)).collect();
    unmatched_list.sort_by(|a, b| b.1.cmp(&a.1));
    let unmatched_total: usize = unmatched_list.iter().map(|x| x.1).sum();

    // majority vote per grid cell
    let grid_height = GRID_WIDTH / 2;
    let mut grid = vec![0u8; GRID_WIDTH * grid_height];
    let palette_len = options.palette.len() + 1;
    grid.par_chunks_mut(GRID_WIDTH).enumerate().for_each(|(gy, row)| {
        let y0 = gy * height / grid_height;
        let y1 = ((gy + 1) * height / grid_height).max(y0 + 1);
        let mut votes = vec![0u32; palette_len];
        for (gx, out) in row.iter_mut().enumerate() {
            let x0 = gx * width / GRID_WIDTH;
            let x1 = ((gx + 1) * width / GRID_WIDTH).max(x0 + 1);
            votes.iter_mut().for_each(|v| *v = 0);
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * width + x) * 4;
                    if rgba[i + 3] < 128 {
                        continue;
                    }
                    let key = u32::from_be_bytes([0, rgba[i], rgba[i + 1], rgba[i + 2]]);
                    votes[lookup[&key] as usize] += 1;
                }
            }
            let (class, _) = votes.iter().enumerate().skip(1).max_by_key(|(_, &n)| n).unwrap_or((0, &0));
            *out = if votes[class] == 0 { 0 } else { class as u8 };
            if let Some(map) = terrain {
                let lon = (gx as f64 + 0.5) / GRID_WIDTH as f64 * 360.0 - 180.0;
                let lat = 90.0 - (gy as f64 + 0.5) / grid_height as f64 * 180.0;
                if map.sample(lon, lat) <= 0.0 {
                    *out = 0;
                }
            }
        }
    });

    let mut counts = vec![0usize; palette_len];
    for &c in &grid {
        counts[c as usize] += 1;
    }
    let classified: usize = counts.iter().skip(1).sum();
    let shares = options
        .palette
        .iter()
        .enumerate()
        .filter(|(i, _)| counts[i + 1] > 0)
        .map(|(i, e)| (e.code.clone(), counts[i + 1] as f32 / classified.max(1) as f32))
        .collect();

    let id = format!("{hash}{}", if options.crop_square { "-c" } else { "" });
    let dir = cache_root.join("koppen").join(&id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("classes.u8"), &grid).map_err(|e| e.to_string())?;
    let meta = KoppenMeta {
        id,
        source: options.path.clone(),
        hash,
        width: GRID_WIDTH,
        height: grid_height,
        codes: options.palette.iter().map(|e| e.code.clone()).collect(),
        shares,
        unmatched: unmatched_total as f32 / total.max(1) as f32,
        unmatched_colors: unmatched_list
            .iter()
            .take(8)
            .map(|&(k, n)| {
                let [_, r, g, b] = k.to_be_bytes();
                (format!("#{r:02x}{g:02x}{b:02x}"), n as f32 / total.max(1) as f32)
            })
            .collect(),
    };
    fs::write(dir.join("meta.json"), serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(meta)
}

/// the colours of a climate map with their shares, to set up a palette by hand
pub fn histogram(path: &Path, limit: usize) -> Result<Vec<(String, f32)>, String> {
    let (rgba, _) = raster::read_rgba8(path)?;
    let mut counts: HashMap<u32, usize> = HashMap::new();
    for p in rgba.chunks_exact(4) {
        if p[3] >= 128 {
            *counts.entry(u32::from_be_bytes([0, p[0], p[1], p[2]])).or_default() += 1;
        }
    }
    let total: usize = counts.values().sum();
    let mut list: Vec<(u32, usize)> = counts.into_iter().collect();
    list.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(list
        .into_iter()
        .take(limit)
        .map(|(k, n)| {
            let [_, r, g, b] = k.to_be_bytes();
            (format!("#{r:02x}{g:02x}{b:02x}"), n as f32 / total.max(1) as f32)
        })
        .collect())
}
