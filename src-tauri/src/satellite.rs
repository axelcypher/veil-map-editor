// Pictures of the whole planet as map layers: the colour render from Gaea (the "satellite image")
// and any number of own image layers, such as pre-rendered map styles. Like the heightmap they are
// read-only and only checked, never adjusted: 2:1, or a square export cut to its middle on request.
// Transparency is kept, so a layer can carry only borders or lettering.
use crate::raster;
use crate::tiles::{self, TILE};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SatelliteOptions {
    pub path: String,
    #[serde(default)]
    pub crop_square: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SatelliteMeta {
    pub id: String,
    pub source: String,
    pub hash: String,
    pub width: usize,
    pub height: usize,
    pub crop_square: bool,
    pub max_zoom: u32,
    pub tile_size: usize,
    #[serde(default = "png")]
    pub tile_ext: String,
    /// the tiles carry transparency
    #[serde(default)]
    pub alpha: bool,
    pub created_at: u64,
}

fn png() -> String {
    "png".into()
}

pub fn cache_dir(cache_root: &Path, id: &str) -> PathBuf {
    cache_root.join("satellite").join(id)
}

pub fn import(options: &SatelliteOptions, cache_root: &Path, progress: &dyn Fn(&str, f32)) -> Result<SatelliteMeta, String> {
    let path = Path::new(&options.path);
    progress("Bild lesen", 0.02);
    let hash = raster::file_hash(path)?;
    let id = format!("{hash}{}", if options.crop_square { "-c" } else { "" });
    let dir = cache_dir(cache_root, &id);
    let meta_path = dir.join("meta.json");
    // an original import is reused; a cache unpacked from an archive is rebuilt at full quality
    if !dir.join(crate::archive::STAMP).exists() {
        if let Ok(meta) = fs::read_to_string(&meta_path).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<SatelliteMeta>(&t).map_err(|e| e.to_string())) {
            return Ok(meta);
        }
    }

    // into_rgb(a)8 consumes the decoded picture, so a 16k source is held only once
    let image = raster::open_image(path)?;
    let (mut width, mut height) = (image.width() as usize, image.height() as usize);
    let alpha = image.color().has_alpha();
    let channels = if alpha { 4 } else { 3 };
    let mut rgb = if alpha { image.into_rgba8().into_raw() } else { image.into_rgb8().into_raw() };
    if options.crop_square && width == height {
        let top = height / 4;
        let rows = height / 2;
        rgb = rgb[top * width * channels..(top + rows) * width * channels].to_vec();
        height = rows;
    }
    raster::check_ratio(width, height)?;
    let (source_width, source_height) = (width, height);

    let _ = fs::remove_dir_all(&dir);
    let tiles_dir = dir.join("tiles");
    fs::create_dir_all(&tiles_dir).map_err(|e| e.to_string())?;

    let max_zoom = tiles::max_zoom_for(width);
    let top_width = 512usize << max_zoom;
    if top_width != width {
        progress("Auf Kachelraster umrechnen", 0.08);
        rgb = tiles::resample(&rgb, width, height, channels, top_width, top_width / 2);
        width = top_width;
        height = top_width / 2;
    }
    for z in (0..=max_zoom).rev() {
        progress("Kacheln schreiben", 0.1 + 0.85 * ((max_zoom - z) as f32 / (max_zoom + 1) as f32));
        tiles::write_level(&rgb, width, height, channels, z, &tiles_dir)?;
        if z > 0 {
            rgb = tiles::halve(&rgb, width, height, channels);
            width /= 2;
            height /= 2;
        }
    }

    let meta = SatelliteMeta {
        id,
        source: options.path.clone(),
        hash,
        width: source_width,
        height: source_height,
        crop_square: options.crop_square,
        max_zoom,
        tile_size: TILE,
        tile_ext: png(),
        alpha,
        created_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
    };
    fs::write(&meta_path, serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    progress("Fertig", 1.0);
    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_a_small_picture_into_a_pyramid() {
        let root = std::env::temp_dir().join(format!("veil-sat-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("sat.png");
        image::RgbImage::from_fn(1024, 512, |x, y| image::Rgb([(x / 4) as u8, (y / 2) as u8, 90])).save(&source).unwrap();
        let meta = import(&SatelliteOptions { path: source.to_string_lossy().into(), crop_square: false }, &root, &|_, _| {}).unwrap();
        assert_eq!(meta.max_zoom, 1);
        let dir = cache_dir(&root, &meta.id).join("tiles");
        assert!(dir.join("0/1/0.png").exists());
        assert!(dir.join("1/3/1.png").exists());
        assert!(!dir.join("1/4/0.png").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
