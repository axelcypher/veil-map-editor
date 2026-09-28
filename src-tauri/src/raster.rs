// Loading source rasters: heightmaps, river masks and climate maps. Nothing here converts silently;
// the caller decides what a mismatch means.
use image::{DynamicImage, ImageReader};
use std::fs;
use std::path::Path;

pub struct Gray16 {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u16>,
}

/// what the file itself looked like before any decision was made
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub format: String,
    pub width: usize,
    pub height: usize,
    pub bit_depth: u32,
    pub channels: u32,
    pub float: bool,
}

pub fn open_image(path: &Path) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::open(path)
        .map_err(|e| format!("Datei lässt sich nicht öffnen: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Format nicht erkannt: {e}"))?;
    reader.no_limits();
    reader.decode().map_err(|e| format!("Bild lässt sich nicht lesen: {e}"))
}

pub fn describe(image: &DynamicImage, format: &str) -> SourceInfo {
    let color = image.color();
    SourceInfo {
        format: format.to_string(),
        width: image.width() as usize,
        height: image.height() as usize,
        bit_depth: (color.bits_per_pixel() / color.channel_count() as u16) as u32,
        channels: color.channel_count() as u32,
        float: matches!(color, image::ColorType::Rgb32F | image::ColorType::Rgba32F),
    }
}

fn extension(path: &Path) -> String {
    path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase()
}

/// A Gaea RAW/R16 export: little-endian 16 bit without a header. Only 2:1 or square sizes can be
/// told from the byte count.
fn read_raw16(path: &Path) -> Result<(Gray16, SourceInfo), String> {
    let bytes = fs::read(path).map_err(|e| format!("Datei lässt sich nicht lesen: {e}"))?;
    if bytes.len() % 2 != 0 {
        return Err("RAW-Datei hat eine ungerade Byte-Zahl, das ist kein 16-Bit-Raster.".into());
    }
    let count = bytes.len() / 2;
    let half = ((count / 2) as f64).sqrt().round() as usize;
    let square = (count as f64).sqrt().round() as usize;
    let (width, height) = if half * half * 2 == count {
        (half * 2, half)
    } else if square * square == count {
        (square, square)
    } else {
        return Err("Die Größe der RAW-Datei passt weder zu 2:1 noch zu einem Quadrat.".into());
    };
    let data = bytes.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
    let info = SourceInfo { format: "RAW 16 Bit".into(), width, height, bit_depth: 16, channels: 1, float: false };
    Ok((Gray16 { width, height, data }, info))
}

/// A single-channel 16-bit raster. Everything else is an error with a reason, never a conversion.
pub fn read_gray16(path: &Path) -> Result<(Gray16, SourceInfo), String> {
    let ext = extension(path);
    if ext == "r16" || ext == "raw" {
        return read_raw16(path);
    }
    let image = open_image(path)?;
    let info = describe(&image, &ext.to_uppercase());
    let (width, height) = (info.width, info.height);
    match image {
        DynamicImage::ImageLuma16(buffer) => Ok((Gray16 { width, height, data: buffer.into_raw() }, info)),
        DynamicImage::ImageLumaA16(buffer) => {
            let data = buffer.into_raw().chunks_exact(2).map(|p| p[0]).collect();
            Ok((Gray16 { width, height, data }, info))
        }
        DynamicImage::ImageRgb16(_) | DynamicImage::ImageRgba16(_) => Err(format!(
            "Die Datei ist farbig ({} Kanäle). Erwartet wird ein Graustufenbild mit einem Kanal.",
            info.channels
        )),
        DynamicImage::ImageRgb32F(_) | DynamicImage::ImageRgba32F(_) => Err(
            "Die Datei enthält Gleitkommawerte. Erwartet werden 16 Bit ohne Normalisierung in unserer Höhenkodierung.".into(),
        ),
        _ => Err(format!(
            "Die Datei hat {} Bit pro Kanal. Erwartet werden 16 Bit; eine 8-Bit-Datei kann die Höhenkodierung nicht tragen.",
            info.bit_depth
        )),
    }
}

/// Gaea builds square; the 2:1 master sits in the middle. Cutting it out is the documented step
/// from the vault note, done here only when the user asks for it.
pub fn crop_square_middle<T: Copy>(data: &[T], width: usize, height: usize) -> Result<(Vec<T>, usize, usize), String> {
    if width != height {
        return Err("Mitte ausschneiden geht nur bei einem quadratischen Export.".into());
    }
    let top = height / 4;
    let rows = height / 2;
    Ok((data[top * width..(top + rows) * width].to_vec(), width, rows))
}

/// any raster as brightness 0..1, for masks and flow maps
pub fn read_luma(path: &Path) -> Result<(Vec<f32>, SourceInfo), String> {
    let ext = extension(path);
    if ext == "r16" || ext == "raw" {
        let (gray, info) = read_raw16(path)?;
        return Ok((gray.data.iter().map(|&v| v as f32 / 65535.0).collect(), info));
    }
    let image = open_image(path)?;
    let info = describe(&image, &ext.to_uppercase());
    let values = match image {
        DynamicImage::ImageLuma8(b) => b.into_raw().into_iter().map(|v| v as f32 / 255.0).collect(),
        DynamicImage::ImageLuma16(b) => b.into_raw().into_iter().map(|v| v as f32 / 65535.0).collect(),
        DynamicImage::ImageRgb32F(b) => b.pixels().map(|p| (p[0] + p[1] + p[2]) / 3.0).collect(),
        DynamicImage::ImageRgba32F(b) => b.pixels().map(|p| (p[0] + p[1] + p[2]) / 3.0).collect(),
        other => other.to_luma16().into_raw().into_iter().map(|v| v as f32 / 65535.0).collect(),
    };
    Ok((values, info))
}

pub fn read_rgba8(path: &Path) -> Result<(Vec<u8>, SourceInfo), String> {
    let image = open_image(path)?;
    let info = describe(&image, &extension(path).to_uppercase());
    Ok((image.to_rgba8().into_raw(), info))
}

pub fn file_hash(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("Datei lässt sich nicht lesen: {e}"))?;
    Ok(blake3::hash(&bytes).to_hex()[..16].to_string())
}

/// the 2:1 check shared by all imports
pub fn check_ratio(width: usize, height: usize) -> Result<(), String> {
    if width != height * 2 {
        let hint = if width == height {
            " Der Export ist quadratisch (Gaea): „Mitte 2:1 ausschneiden“ aktivieren oder in Photoshop zuschneiden."
        } else {
            ""
        };
        return Err(format!("Seitenverhältnis {width} × {height} ist nicht 2:1.{hint}"));
    }
    Ok(())
}
