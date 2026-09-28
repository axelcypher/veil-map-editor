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
