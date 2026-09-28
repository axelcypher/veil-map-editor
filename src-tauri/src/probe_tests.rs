// Runs the importers on real files. Ignored by default:
// VEIL_PROBE_OUT=<dir> cargo test --release --lib probe -- --ignored --nocapture
use crate::{heightmap, koppen, raster, rivers};
use std::path::{Path, PathBuf};
use std::time::Instant;

fn out_dir() -> PathBuf {
    PathBuf::from(std::env::var("VEIL_PROBE_OUT").expect("VEIL_PROBE_OUT"))
}

#[test]
#[ignore]
fn probe_heightmap() {
    let path = std::env::var("VEIL_PROBE_HEIGHTMAP").expect("VEIL_PROBE_HEIGHTMAP");
    let crop = std::env::var("VEIL_PROBE_CROP").is_ok();
    let options = heightmap::ImportOptions { path: path.clone(), crop_square: crop, control_points: vec![] };
    let start = Instant::now();
    let (checks, source, map) = heightmap::run_checks(&options);
    println!("source {source:?}");
    for c in &checks {
        println!("[{}] {}: {}", c.status, c.label, c.detail);
    }
    println!("checks {:?}", start.elapsed());
    let Some(map) = map else { return };
    if checks.iter().any(|c| c.status == "error") {
        return;
    }
    let hash = raster::file_hash(Path::new(&path)).unwrap();
    let meta = heightmap::build_cache(&map, &options, &hash, 6_606_727.0, &out_dir(), &|stage, f| {
        println!("{:>6.1?} {stage} {f:.2}", start.elapsed());
    })
    .unwrap();
    println!("{meta:?}");
}

#[test]
#[ignore]
fn probe_koppen_histogram() {
    let path = std::env::var("VEIL_PROBE_KOPPEN").expect("VEIL_PROBE_KOPPEN");
    for (color, share) in koppen::histogram(Path::new(&path), 48).unwrap() {
        println!("{color} {:.3}%", share * 100.0);
    }
}

#[test]
#[ignore]
fn probe_thumbnail() {
    let path = std::env::var("VEIL_PROBE_IMAGE").expect("VEIL_PROBE_IMAGE");
    let image = raster::open_image(Path::new(&path)).unwrap();
    // a crop at full resolution and a small overview
    image.crop_imm(9000, 3000, 1400, 900).save(out_dir().join("crop.png")).unwrap();
    image.resize(2048, 1024, image::imageops::FilterType::Nearest).save(out_dir().join("thumb.png")).unwrap();
}

/// a stand-in for a Gaea rivers mask: flow accumulation on the real heightmap
#[test]
#[ignore]
fn probe_make_river_mask() {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    let path = std::env::var("VEIL_PROBE_HEIGHTMAP").expect("VEIL_PROBE_HEIGHTMAP");
    let (gray, _) = raster::read_gray16(Path::new(&path)).unwrap();
    let (w, h) = (4096usize, 2048usize);
    let step = gray.width / w;
    let mut z = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            z[y * w + x] = heightmap::meters(gray.data[(y * step) * gray.width + x * step]);
        }
    }
    // priority flood from the sea: every land cell gets a way down
    let key = |v: f32| (v * 100.0) as i64;
    let mut done = vec![false; w * h];
    let mut order = Vec::with_capacity(w * h);
    let mut heap = BinaryHeap::new();
    for i in 0..w * h {
        if z[i] <= 0.0 {
            done[i] = true;
            heap.push(Reverse((key(z[i]), i)));
        }
    }
    let mut down = vec![usize::MAX; w * h];
    while let Some(Reverse((_, i))) = heap.pop() {
        order.push(i);
        let (x, y) = ((i % w) as isize, (i / w) as isize);
        for (dx, dy) in [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)] {
            let (nx, ny) = ((x + dx).rem_euclid(w as isize), y + dy);
            if ny < 0 || ny >= h as isize {
                continue;
            }
            let n = ny as usize * w + nx as usize;
            if done[n] {
                continue;
            }
            done[n] = true;
            z[n] = z[n].max(z[i] + 0.01);
            down[n] = i;
            heap.push(Reverse((key(z[n]), n)));
        }
    }
    let mut acc = vec![1f32; w * h];
    for &i in order.iter().rev() {
        if down[i] != usize::MAX {
            acc[down[i]] += acc[i];
        }
    }
    let mut image = image::GrayImage::new(w as u32, h as u32);
    for i in 0..w * h {
        if z[i] > 0.0 && acc[i] > 900.0 {
            image.put_pixel((i % w) as u32, (i / w) as u32, image::Luma([255]));
        }
    }
    image.save(out_dir().join("rivers_mask.png")).unwrap();
}

#[test]
#[ignore]
fn probe_rivers() {
    let path = std::env::var("VEIL_PROBE_RIVERS").expect("VEIL_PROBE_RIVERS");
    let (values, info) = raster::read_luma(Path::new(&path)).unwrap();
    let options = rivers::RiverOptions {
        path: path.clone(),
        threshold: 0.5,
        min_length_km: 30.0,
        simplify_px: 0.7,
        prune_px: 4.0,
        crop_square: false,
    };
    let start = Instant::now();
    let result = rivers::extract(&values, info.width, info.height, &options, None, 6606.727).unwrap();
    println!("{} rivers from {} skeleton pixels in {:?}", result.rivers.len(), result.pixels, start.elapsed());
    for r in result.rivers.iter().take(10) {
        println!("#{} parent {:?} {:.0} km, upstream {:.0} km, {} points", r.index, r.parent, r.length_km, r.upstream_km, r.coords.len());
    }
}

/// fractal value noise, seamless east–west, for synthetic test worlds
fn fractal(width: usize, height: usize, seed: u32) -> Vec<f32> {
    use rayon::prelude::*;
    let hash = |x: i64, y: i64, o: u32| -> f32 {
        let mut h = (x as u64).wrapping_mul(0x9E3779B97F4A7C15) ^ (y as u64).wrapping_mul(0xC2B2AE3D27D4EB4F) ^ ((seed ^ o) as u64).wrapping_mul(0x165667B19E3779F9);
        h ^= h >> 29;
        h = h.wrapping_mul(0xBF58476D1CE4E5B9);
        h ^= h >> 32;
        (h & 0xFFFFFF) as f32 / 0xFFFFFF as f32 * 2.0 - 1.0
    };
    let mut out = vec![0f32; width * height];
    out.par_chunks_mut(width).enumerate().for_each(|(y, row)| {
        for (x, v) in row.iter_mut().enumerate() {
            let mut sum = 0.0;
            let mut amp = 1.0;
            let mut cells = 4i64;
            for o in 0..12u32 {
                let fx = x as f64 / width as f64 * cells as f64;
                let fy = y as f64 / height as f64 * (cells / 2).max(1) as f64;
                let (x0, y0) = (fx.floor() as i64, fy.floor() as i64);
                let (tx, ty) = ((fx - x0 as f64) as f32, (fy - y0 as f64) as f32);
                let (sx, sy) = (tx * tx * (3.0 - 2.0 * tx), ty * ty * (3.0 - 2.0 * ty));
                let w = |xx: i64| xx.rem_euclid(cells);
                let a = hash(w(x0), y0, o);
                let b = hash(w(x0 + 1), y0, o);
                let c = hash(w(x0), y0 + 1, o);
                let d = hash(w(x0 + 1), y0 + 1, o);
                sum += amp * ((a * (1.0 - sx) + b * sx) * (1.0 - sy) + (c * (1.0 - sx) + d * sx) * sy);
                amp *= 0.52;
                cells *= 2;
            }
            *v = sum;
        }
    });
    out
}

#[test]
#[ignore]
fn probe_synthesize_world() {
    let (w, h) = (16384usize, 8192usize);
    let start = Instant::now();
    let noise = fractal(w, h, 7);
    let heights: Vec<u16> = noise.iter().map(|n| heightmap::encode((n * 7000.0 - 1500.0).clamp(-11000.0, 8500.0))).collect();
    image::ImageBuffer::<image::Luma<u16>, Vec<u16>>::from_raw(w as u32, h as u32, heights).unwrap().save(out_dir().join("synthetic-height.png")).unwrap();
    println!("heightmap {:?}", start.elapsed());
    let texture = fractal(w, h, 99);
    let mut rgb = vec![0u8; w * h * 3];
    for i in 0..w * h {
        let m = noise[i] * 7000.0 - 1500.0;
        let t = texture[i];
        let c: [f32; 3] = if m <= 0.0 { [20.0, 50.0 + m.max(-4000.0) / 200.0, 90.0 + m.max(-4000.0) / 100.0] } else if m < 2500.0 { [70.0 + 60.0 * t, 90.0 + 40.0 * t, 50.0 + 30.0 * t] } else { [150.0 + 50.0 * t, 140.0 + 50.0 * t, 130.0 + 50.0 * t] };
        for k in 0..3 {
            rgb[i * 3 + k] = c[k].clamp(0.0, 255.0) as u8;
        }
    }
    image::RgbImage::from_raw(w as u32, h as u32, rgb).unwrap().save(out_dir().join("synthetic-satellite.png")).unwrap();
    println!("satellite {:?}", start.elapsed());
}

#[test]
#[ignore]
fn probe_archive() {
    use crate::{archive, satellite, tiles::TileEncoding};
    let out = out_dir();
    let start = Instant::now();
    let path = out.join("synthetic-height.png").to_string_lossy().to_string();
    let options = heightmap::ImportOptions { path: path.clone(), crop_square: false, control_points: vec![] };
    let (_, _, map) = heightmap::run_checks(&options);
    let meta = heightmap::build_cache(&map.unwrap(), &options, "synthetic", 6_606_727.0, &out, &|_, _| {}).unwrap();
    println!("terrain cache {:?}", start.elapsed());
    let sat = satellite::import(&satellite::SatelliteOptions { path: out.join("synthetic-satellite.png").to_string_lossy().into(), crop_square: false }, &out, &|_, _| {}).unwrap();
    println!("satellite cache {:?}", start.elapsed());
    let quality: f32 = std::env::var("VEIL_PROBE_QUALITY").ok().and_then(|q| q.parse().ok()).unwrap_or(85.0);
    for heights in ["none", "half", "full"] {
        let target = out.join(format!("probe-q{quality}-{heights}.veilmap"));
        let report = archive::write(
            &archive::SaveOptions {
                project: "{}".into(),
                terrain_id: Some(meta.id.clone()),
                koppen_id: None,
                satellite_id: Some(sat.id.clone()),
                image_ids: vec![],
                tiles: TileEncoding { quality, lossless: false },
                heights: heights.into(),
            },
            &out,
            &target,
            &|_, _| {},
        )
        .unwrap();
        println!("{:?} q{quality} heights={heights}: {report:?} ({:.1} MB)", start.elapsed(), report.bytes as f64 / 1e6);
    }
}

/// a transparent 2:1 overlay (a grid of red lines) as an image layer, for checking the display
#[test]
#[ignore]
fn probe_image_layer() {
    let out = out_dir();
    let source = out.join("overlay.png");
    image::RgbaImage::from_fn(2048, 1024, |x, y| if x % 128 < 4 || y % 128 < 4 { image::Rgba([230, 40, 40, 255]) } else { image::Rgba([0, 0, 0, 0]) })
        .save(&source)
        .unwrap();
    let meta = crate::satellite::import(&crate::satellite::SatelliteOptions { path: source.to_string_lossy().into(), crop_square: false }, &out, &|_, _| {}).unwrap();
    println!("{}", serde_json::to_string(&meta).unwrap());
}
