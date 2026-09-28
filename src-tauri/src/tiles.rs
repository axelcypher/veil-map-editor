// Tile pyramids and tile encoding. The import cache keeps lossless PNG tiles; an archive for another
// device carries them as WebP, which is a fraction of the size for the same picture.
use image::{ImageEncoder, RgbImage};
use rayon::prelude::*;
use std::fs;
use std::path::Path;

pub const TILE: usize = 256;

/// the zoom levels for a raster of this width: level z is 512·2^z px wide, the top one at least
/// as wide as the source
pub fn max_zoom_for(width: usize) -> u32 {
    let mut max_zoom = 0u32;
    while 512usize << max_zoom < width && max_zoom < 7 {
        max_zoom += 1;
    }
    max_zoom
}

pub fn write_png_rgb(path: &Path, image: &RgbImage) -> Result<(), String> {
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

/// how an archive carries its tiles
#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TileEncoding {
    /// WebP quality 1..100
    pub quality: f32,
    /// WebP without loss; larger, but pixel-identical to the cache
    #[serde(default)]
    pub lossless: bool,
}

/// A tile as WebP. Tiles that already are WebP are passed through unchanged, so saving an archive
/// again never loses quality a second time. Transparency is kept where a tile has any.
pub fn to_webp(bytes: &[u8], encoding: TileEncoding) -> Result<Vec<u8>, String> {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Ok(bytes.to_vec());
    }
    let image = image::load_from_memory(bytes).map_err(|e| format!("Kachel lässt sich nicht lesen: {e}"))?;
    let encode = |encoder: webp::Encoder| {
        let memory = if encoding.lossless { encoder.encode_lossless() } else { encoder.encode(encoding.quality.clamp(1.0, 100.0)) };
        memory.to_vec()
    };
    if image.color().has_alpha() {
        let rgba = image.to_rgba8();
        if rgba.pixels().any(|p| p[3] < 255) {
            return Ok(encode(webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height())));
        }
    }
    let rgb = image.to_rgb8();
    Ok(encode(webp::Encoder::from_rgb(rgb.as_raw(), rgb.width(), rgb.height())))
}

/// Mixes pixels of an RGB (3 channels) or RGBA (4) raster by weight. With alpha the colours are
/// weighted by it as well, so transparent pixels do not darken the edges of what is drawn.
#[inline]
fn mix(data: &[u8], channels: usize, samples: &[(usize, f32)], out: &mut [u8]) {
    if channels == 4 {
        let coverage: f32 = samples.iter().map(|&(i, w)| w * data[i + 3] as f32).sum();
        for c in 0..3 {
            let sum: f32 = samples.iter().map(|&(i, w)| w * data[i + 3] as f32 * data[i + c] as f32).sum();
            out[c] = if coverage > 0.0 { (sum / coverage).round().clamp(0.0, 255.0) as u8 } else { 0 };
        }
        out[3] = coverage.round().clamp(0.0, 255.0) as u8;
    } else {
        for c in 0..channels {
            let sum: f32 = samples.iter().map(|&(i, w)| w * data[i + c] as f32).sum();
            out[c] = sum.round().clamp(0.0, 255.0) as u8;
        }
    }
}

/// Area-averaged half size of an RGB or RGBA raster.
pub fn halve(data: &[u8], width: usize, height: usize, channels: usize) -> Vec<u8> {
    let (w, h) = (width / 2, height / 2);
    let mut out = vec![0u8; w * h * channels];
    out.par_chunks_mut(w * channels).enumerate().for_each(|(y, row)| {
        let (r0, r1) = (2 * y * width, (2 * y + 1) * width);
        for x in 0..w {
            let samples = [
                ((r0 + 2 * x) * channels, 0.25),
                ((r0 + 2 * x + 1) * channels, 0.25),
                ((r1 + 2 * x) * channels, 0.25),
                ((r1 + 2 * x + 1) * channels, 0.25),
            ];
            mix(data, channels, &samples, &mut row[x * channels..(x + 1) * channels]);
        }
    });
    out
}

/// Bilinear resize to the tile raster, wrapping east–west; only used when the source width is
/// not a power-of-two multiple of 512.
pub fn resample(data: &[u8], width: usize, height: usize, channels: usize, to_width: usize, to_height: usize) -> Vec<u8> {
    let mut out = vec![0u8; to_width * to_height * channels];
    out.par_chunks_mut(to_width * channels).enumerate().for_each(|(y, row)| {
        let sy = ((y as f64 + 0.5) * height as f64 / to_height as f64 - 0.5).clamp(0.0, (height - 1) as f64);
        let y0 = sy.floor() as usize;
        let y1 = (y0 + 1).min(height - 1);
        let fy = (sy - y0 as f64) as f32;
        for x in 0..to_width {
            let sx = (x as f64 + 0.5) * width as f64 / to_width as f64 - 0.5;
            let x0f = sx.floor();
            let fx = (sx - x0f) as f32;
            let x0 = (x0f as isize).rem_euclid(width as isize) as usize;
            let x1 = (x0 + 1) % width;
            let at = |xx: usize, yy: usize| (yy * width + xx) * channels;
            let samples = [
                (at(x0, y0), (1.0 - fx) * (1.0 - fy)),
                (at(x1, y0), fx * (1.0 - fy)),
                (at(x0, y1), (1.0 - fx) * fy),
                (at(x1, y1), fx * fy),
            ];
            mix(data, channels, &samples, &mut row[x * channels..(x + 1) * channels]);
        }
    });
    out
}

/// Cuts one level of an RGB or RGBA raster into PNG tiles under `dir/<z>/<x>/<y>.png`.
pub fn write_level(data: &[u8], width: usize, height: usize, channels: usize, z: u32, dir: &Path) -> Result<(), String> {
    let tiles_x = width / TILE;
    let tiles_y = height / TILE;
    for tx in 0..tiles_x {
        fs::create_dir_all(dir.join(z.to_string()).join(tx.to_string())).map_err(|e| e.to_string())?;
    }
    let color = if channels == 4 { image::ExtendedColorType::Rgba8 } else { image::ExtendedColorType::Rgb8 };
    (0..tiles_x * tiles_y).into_par_iter().try_for_each(|index| -> Result<(), String> {
        let (tx, ty) = (index % tiles_x, index / tiles_x);
        let row = TILE * channels;
        let mut tile = vec![0u8; TILE * row];
        for py in 0..TILE {
            let start = ((ty * TILE + py) * width + tx * TILE) * channels;
            tile[py * row..(py + 1) * row].copy_from_slice(&data[start..start + row]);
        }
        let path = dir.join(z.to_string()).join(tx.to_string()).join(format!("{ty}.png"));
        let file = fs::File::create(&path).map_err(|e| e.to_string())?;
        image::codecs::png::PngEncoder::new_with_quality(
            std::io::BufWriter::new(file),
            image::codecs::png::CompressionType::Fast,
            image::codecs::png::FilterType::Sub,
        )
        .write_image(&tile, TILE as u32, TILE as u32, color)
        .map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halving_averages_blocks() {
        let data = vec![0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0, 10, 20, 30, 10, 20, 30, 10, 20, 30, 10, 20, 30];
        // 4 × 2 → 2 × 1
        let out = halve(&data, 4, 2, 3);
        assert_eq!(out.len(), 6);
        // (0 + 255 + 10 + 10) / 4, rounded, per channel
        assert_eq!(&out[0..3], &[69, 74, 79]);
        assert_eq!(&out[3..6], &[69, 74, 79]);
    }

    #[test]
    fn webp_passthrough_and_encode() {
        let tile = RgbImage::from_fn(64, 64, |x, y| image::Rgb([x as u8 * 4, y as u8 * 4, 128]));
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(tile.as_raw(), 64, 64, image::ExtendedColorType::Rgb8)
            .unwrap();
        let webp = to_webp(&png, TileEncoding { quality: 85.0, lossless: false }).unwrap();
        assert_eq!(&webp[0..4], b"RIFF");
        assert_eq!(to_webp(&webp, TileEncoding { quality: 10.0, lossless: false }).unwrap(), webp);
        let decoded = image::load_from_memory(&webp).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (64, 64));
    }

    #[test]
    fn transparency_survives_webp_and_halving() {
        // left half opaque red, right half fully transparent black
        let tile = image::RgbaImage::from_fn(64, 64, |x, _| if x < 32 { image::Rgba([200, 0, 0, 255]) } else { image::Rgba([0, 0, 0, 0]) });
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png).write_image(tile.as_raw(), 64, 64, image::ExtendedColorType::Rgba8).unwrap();
        let webp = to_webp(&png, TileEncoding { quality: 90.0, lossless: false }).unwrap();
        let decoded = image::load_from_memory(&webp).unwrap().to_rgba8();
        assert!(decoded.get_pixel(60, 10)[3] < 10, "transparent stays transparent");
        assert!(decoded.get_pixel(4, 10)[3] > 245);

        // a 2 × 2 block of one red and three clear pixels: red at a quarter coverage, not dark red
        let data = [200, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(halve(&data, 2, 2, 4), vec![200, 0, 0, 64]);
    }
}
