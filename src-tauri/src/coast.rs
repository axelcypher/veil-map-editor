// Land polygons from a height raster by marching squares. The raster is padded with sea, so every
// ring closes; land crossing ±180° becomes two polygons, as GeoJSON wants it.
use serde_json::{json, Value};
use std::collections::HashMap;

type Pt = (f64, f64);

/// Douglas-Peucker on a closed ring (first point not repeated)
pub fn simplify_ring(points: &[Pt], tolerance: f64) -> Vec<Pt> {
    if points.len() < 8 || tolerance <= 0.0 {
        return points.to_vec();
    }
    // split at the point farthest from the first so both halves are open polylines
    let first = points[0];
    let far = (1..points.len())
        .max_by(|&a, &b| {
            let da = (points[a].0 - first.0).powi(2) + (points[a].1 - first.1).powi(2);
            let db = (points[b].0 - first.0).powi(2) + (points[b].1 - first.1).powi(2);
            da.partial_cmp(&db).unwrap()
        })
        .unwrap();
    let mut a = simplify_line(&points[..=far], tolerance);
    let mut second: Vec<Pt> = points[far..].to_vec();
    second.push(first);
    let b = simplify_line(&second, tolerance);
    a.pop();
    a.extend_from_slice(&b[..b.len() - 1]);
    a
}

pub fn simplify_line(points: &[Pt], tolerance: f64) -> Vec<Pt> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0usize, points.len() - 1)];
    let tol2 = tolerance * tolerance;
    while let Some((start, end)) = stack.pop() {
        let (ax, ay) = points[start];
        let (bx, by) = points[end];
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let mut best = 0.0;
        let mut index = 0;
        for i in start + 1..end {
            let (px, py) = points[i];
            let d2 = if len2 == 0.0 {
                (px - ax).powi(2) + (py - ay).powi(2)
            } else {
                let t = (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0);
                (px - ax - t * dx).powi(2) + (py - ay - t * dy).powi(2)
            };
            if d2 > best {
                best = d2;
                index = i;
            }
        }
        if best > tol2 {
            keep[index] = true;
            stack.push((start, index));
            stack.push((index, end));
        }
    }
    points.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

fn signed_area(ring: &[Pt]) -> f64 {
    let mut sum = 0.0;
    for i in 0..ring.len() {
        let (x1, y1) = ring[i];
        let (x2, y2) = ring[(i + 1) % ring.len()];
        sum += x1 * y2 - x2 * y1;
    }
    sum / 2.0
}

fn contains(ring: &[Pt], p: Pt) -> bool {
    let mut inside = false;
    let mut j = ring.len() - 1;
    for i in 0..ring.len() {
        let (xi, yi) = ring[i];
        let (xj, yj) = ring[j];
        if (yi > p.1) != (yj > p.1) && p.0 < (xj - xi) * (p.1 - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Returns a GeoJSON MultiPolygon in degrees. `simplify` and `min_area` are in raster pixels.
pub fn land_polygons(values: &[f32], width: usize, height: usize, threshold: f32, simplify: f64, min_area: f64) -> Value {
    // padded grid: (width + 2) × (height + 2) points, the border is sea
    let pw = width + 2;
    let ph = height + 2;
    let value = |x: usize, y: usize| -> f32 {
        if x == 0 || y == 0 || x == pw - 1 || y == ph - 1 {
            threshold - 1.0
        } else {
            values[(y - 1) * width + (x - 1)]
        }
    };
    let horizontal = |x: usize, y: usize| ((y * pw + x) * 2) as u64;
    let vertical = |x: usize, y: usize| ((y * pw + x) * 2 + 1) as u64;

    let mut next: HashMap<u64, u64> = HashMap::new();
    for y in 0..ph - 1 {
        for x in 0..pw - 1 {
            let tl = value(x, y) > threshold;
            let tr = value(x + 1, y) > threshold;
            let br = value(x + 1, y + 1) > threshold;
            let bl = value(x, y + 1) > threshold;
            let case = (tl as u8) << 3 | (tr as u8) << 2 | (br as u8) << 1 | bl as u8;
            if case == 0 || case == 15 {
                continue;
            }
            let t = horizontal(x, y);
            let b = horizontal(x, y + 1);
            let l = vertical(x, y);
            let r = vertical(x + 1, y);
            let mut link = |from: u64, to: u64| {
                next.insert(from, to);
            };
            match case {
                1 => link(l, b),
                2 => link(b, r),
                3 => link(l, r),
                4 => link(r, t),
                5 => {
                    let center = (value(x, y) + value(x + 1, y) + value(x + 1, y + 1) + value(x, y + 1)) / 4.0;
                    if center > threshold {
                        link(l, t);
                        link(r, b);
                    } else {
                        link(r, t);
                        link(l, b);
                    }
                }
                6 => link(b, t),
                7 => link(l, t),
                8 => link(t, l),
                9 => link(t, b),
                10 => {
                    let center = (value(x, y) + value(x + 1, y) + value(x + 1, y + 1) + value(x, y + 1)) / 4.0;
                    if center > threshold {
                        link(t, r);
                        link(b, l);
                    } else {
                        link(t, l);
                        link(b, r);
                    }
                }
                11 => link(t, r),
                12 => link(r, l),
                13 => link(r, b),
                14 => link(b, l),
                _ => {}
            }
        }
    }

    // where an edge crosses the threshold, in raster pixel coordinates (pixel centres at +0.5)
    let point_of = |edge: u64| -> Pt {
        let cell = (edge / 2) as usize;
        let (x, y) = (cell % pw, cell / pw);
        let (x2, y2) = if edge % 2 == 0 { (x + 1, y) } else { (x, y + 1) };
        let (a, b) = (value(x, y), value(x2, y2));
        let t = if (b - a).abs() < f32::EPSILON { 0.5 } else { ((threshold - a) / (b - a)).clamp(0.0, 1.0) as f64 };
        let fx = x as f64 + (x2 as f64 - x as f64) * t - 1.0 + 0.5;
        let fy = y as f64 + (y2 as f64 - y as f64) * t - 1.0 + 0.5;
        (fx, fy)
    };

    let mut rings: Vec<Vec<Pt>> = Vec::new();
    let mut keys: Vec<u64> = next.keys().copied().collect();
    keys.sort_unstable();
    let mut used: HashMap<u64, bool> = HashMap::with_capacity(next.len());
    for start in keys {
        if used.contains_key(&start) {
            continue;
        }
        let mut ring = Vec::new();
        let mut edge = start;
        loop {
            used.insert(edge, true);
            ring.push(point_of(edge));
            match next.get(&edge) {
                Some(&n) if n != start && !used.contains_key(&n) => edge = n,
                _ => break,
            }
        }
        if ring.len() >= 3 {
            rings.push(ring);
        }
    }

    // rings traced clockwise in image coordinates are land; the others are holes (inland sea)
    let mut outers: Vec<(Vec<Pt>, f64, [f64; 4], Vec<Vec<Pt>>)> = Vec::new();
    let mut holes: Vec<Vec<Pt>> = Vec::new();
    for ring in rings {
        let area = signed_area(&ring);
        if area.abs() < min_area {
            continue;
        }
        let ring = simplify_ring(&ring, simplify);
        if ring.len() < 3 {
            continue;
        }
        if area > 0.0 {
            let mut bbox = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
            for &(x, y) in &ring {
                bbox = [bbox[0].min(x), bbox[1].min(y), bbox[2].max(x), bbox[3].max(y)];
            }
            outers.push((ring, area.abs(), bbox, Vec::new()));
        } else {
            holes.push(ring);
        }
    }
    outers.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    for hole in holes {
        let probe = hole[0];
        if let Some(outer) = outers.iter_mut().find(|(ring, _, bbox, _)| {
            probe.0 >= bbox[0] && probe.0 <= bbox[2] && probe.1 >= bbox[1] && probe.1 <= bbox[3] && contains(ring, probe)
        }) {
            outer.3.push(hole);
        }
    }

    let to_lonlat = |&(x, y): &Pt| -> [f64; 2] {
        let lon = x / width as f64 * 360.0 - 180.0;
        let lat = 90.0 - y / height as f64 * 180.0;
        [(lon * 1e5).round() / 1e5, (lat * 1e5).round() / 1e5]
    };
    // land rings run clockwise on the map, holes counter-clockwise; RFC 7946 wants it the other way
    // round, so every ring is reversed
    let close = |ring: &Vec<Pt>, reverse: bool| -> Vec<[f64; 2]> {
        let mut coords: Vec<[f64; 2]> = ring.iter().map(to_lonlat).collect();
        if reverse {
            coords.reverse();
        }
        coords.push(coords[0]);
        coords
    };
    let polygons: Vec<Value> = outers
        .iter()
        .rev()
        .map(|(ring, _, _, holes)| {
            let mut all = vec![json!(close(ring, true))];
            all.extend(holes.iter().map(|h| json!(close(h, true))));
            Value::Array(all)
        })
        .collect();
    json!({ "type": "MultiPolygon", "coordinates": polygons })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn island_with_lake() {
        // 10 × 6 raster: an island with a one-pixel lake
        let (w, h) = (10, 6);
        let mut values = vec![-10.0f32; w * h];
        for y in 1..5 {
            for x in 2..8 {
                values[y * w + x] = 10.0;
            }
        }
        values[2 * w + 4] = -10.0;
        values[3 * w + 4] = -10.0;
        let result = land_polygons(&values, w, h, 0.0, 0.0, 0.1);
        let polygons = result["coordinates"].as_array().unwrap();
        assert_eq!(polygons.len(), 1);
        assert_eq!(polygons[0].as_array().unwrap().len(), 2, "outer ring plus the lake");
        // the outer ring must be counter-clockwise in lon/lat
        let ring: Vec<Pt> = polygons[0][0].as_array().unwrap().iter().map(|p| (p[0].as_f64().unwrap(), p[1].as_f64().unwrap())).collect();
        assert!(signed_area(&ring[..ring.len() - 1]) > 0.0);
    }
}
