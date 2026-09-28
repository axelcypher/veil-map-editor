// River lines from a Gaea rivers mask or flow map: threshold, thin to a one-pixel skeleton, trace
// the skeleton as a graph and split each network into a main stem and its tributaries.
use crate::coast::simplify_line;
use crate::heightmap::Heightmap;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RiverOptions {
    pub path: String,
    /// brightness 0..1 from which a pixel counts as river
    pub threshold: f32,
    pub min_length_km: f64,
    pub simplify_px: f64,
    #[serde(default = "default_prune")]
    pub prune_px: f64,
    #[serde(default)]
    pub crop_square: bool,
}

fn default_prune() -> f64 {
    4.0
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RiverLine {
    pub index: usize,
    pub parent: Option<usize>,
    pub coords: Vec<[f64; 2]>,
    pub length_km: f64,
    /// length of the whole network above the mouth of this river, a stand-in for discharge
    pub upstream_km: f64,
    /// mean brightness of the source raster along the river (flow maps: relative discharge)
    pub flow: f32,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RiverResult {
    pub rivers: Vec<RiverLine>,
    pub pixels: usize,
    pub width: usize,
    pub height: usize,
}

const OFFSETS: [(isize, isize); 8] = [(0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1)];

/// Zhang-Suen thinning, only ever looking at pixels that are still set
fn thin(mask: &mut [u8], width: usize) {
    let mut alive: Vec<usize> = mask.iter().enumerate().filter(|(_, &v)| v != 0).map(|(i, _)| i).collect();
    loop {
        let mut changed = false;
        for step in 0..2 {
            let removable: Vec<usize> = alive
                .par_iter()
                .copied()
                .filter(|&p| {
                    let n = |k: usize| -> u8 {
                        let (dx, dy) = OFFSETS[k];
                        let q = (p as isize + dy * width as isize + dx) as usize;
                        (mask[q] != 0) as u8
                    };
                    let ring = [n(0), n(1), n(2), n(3), n(4), n(5), n(6), n(7)];
                    let b: u8 = ring.iter().sum();
                    if !(2..=6).contains(&b) {
                        return false;
                    }
                    let a = (0..8).filter(|&k| ring[k] == 0 && ring[(k + 1) % 8] == 1).count();
                    if a != 1 {
                        return false;
                    }
                    // P2 = ring[0] (N), P4 = ring[2] (E), P6 = ring[4] (S), P8 = ring[6] (W)
                    if step == 0 {
                        ring[0] * ring[2] * ring[4] == 0 && ring[2] * ring[4] * ring[6] == 0
                    } else {
                        ring[0] * ring[2] * ring[6] == 0 && ring[0] * ring[4] * ring[6] == 0
                    }
                })
                .collect();
            if !removable.is_empty() {
                changed = true;
                for &p in &removable {
                    mask[p] = 0;
                }
            }
        }
        alive.retain(|&p| mask[p] != 0);
        if !changed {
            break;
        }
    }
}

struct Edge {
    a: usize,
    b: usize,
    pixels: Vec<usize>,
    alive: bool,
}

fn find(parent: &mut Vec<usize>, x: usize) -> usize {
    let mut root = x;
    while parent[root] != root {
        root = parent[root];
    }
    let mut node = x;
    while parent[node] != root {
        let next = parent[node];
        parent[node] = root;
        node = next;
    }
    root
}

pub fn extract(
    values: &[f32],
    width: usize,
    height: usize,
    options: &RiverOptions,
    terrain: Option<&Heightmap>,
    radius_km: f64,
) -> Result<RiverResult, String> {
    let mut mask = vec![0u8; width * height];
    let mut count = 0usize;
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            if values[y * width + x] >= options.threshold {
                mask[y * width + x] = 1;
                count += 1;
            }
        }
    }
    if count as f64 > width as f64 * height as f64 * 0.2 {
        return Err(format!(
            "{:.0} % der Karte liegen über der Schwelle – das ist keine Flussmaske. Schwelle erhöhen.",
            count as f64 / (width * height) as f64 * 100.0
        ));
    }
    thin(&mut mask, width);

    let w = width as isize;
    let neighbours = |mask: &[u8], p: usize| -> Vec<usize> {
        OFFSETS
            .iter()
            .map(|(dx, dy)| (p as isize + dy * w + dx) as usize)
            .filter(|&q| mask[q] != 0)
            .collect()
    };
    let skeleton: Vec<usize> = mask.iter().enumerate().filter(|(_, &v)| v != 0).map(|(i, _)| i).collect();
    let pixels = skeleton.len();

    // nodes: ends and junctions; neighbouring junction pixels form one cluster
    let node_pixels: Vec<usize> = skeleton.iter().copied().filter(|&p| neighbours(&mask, p).len() != 2).collect();
    let node_index: HashMap<usize, usize> = node_pixels.iter().enumerate().map(|(i, &p)| (p, i)).collect();
    let mut parent: Vec<usize> = (0..node_pixels.len()).collect();
    for (i, &p) in node_pixels.iter().enumerate() {
        for q in neighbours(&mask, p) {
            if let Some(&j) = node_index.get(&q) {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                if ri != rj {
                    parent[ri] = rj;
                }
            }
        }
    }
    let mut cluster_of_root: HashMap<usize, usize> = HashMap::new();
    let mut cluster_pixels: Vec<Vec<usize>> = Vec::new();
    let mut cluster: HashMap<usize, usize> = HashMap::new();
    for (i, &p) in node_pixels.iter().enumerate() {
        let root = find(&mut parent, i);
        let id = *cluster_of_root.entry(root).or_insert_with(|| {
            cluster_pixels.push(Vec::new());
            cluster_pixels.len() - 1
        });
        cluster_pixels[id].push(p);
        cluster.insert(p, id);
    }

    // trace every run of two-neighbour pixels from one cluster to the next
    let mut edges: Vec<Edge> = Vec::new();
    let mut direct: HashSet<(usize, usize)> = HashSet::new();
    for &n in &node_pixels {
        let cn = cluster[&n];
        for q in neighbours(&mask, n) {
            if let Some(&cq) = cluster.get(&q) {
                if cq != cn && direct.insert((cn.min(cq), cn.max(cq))) {
                    edges.push(Edge { a: cn, b: cq, pixels: vec![n, q], alive: true });
                }
                continue;
            }
            if mask[q] != 1 {
                continue;
            }
            let mut path = vec![n, q];
            mask[q] = 2;
            let (mut prev, mut cur) = (n, q);
            let mut end = None;
            loop {
                let next = neighbours(&mask, cur).into_iter().find(|&r| r != prev && (cluster.contains_key(&r) || mask[r] == 1));
                match next {
                    Some(r) if cluster.contains_key(&r) => {
                        path.push(r);
                        end = Some(cluster[&r]);
                        break;
                    }
                    Some(r) => {
                        mask[r] = 2;
                        path.push(r);
                        prev = cur;
                        cur = r;
                    }
                    None => break,
                }
            }
            if let Some(b) = end {
                if b != cn || path.len() > 8 {
                    edges.push(Edge { a: cn, b, pixels: path, alive: true });
                }
            }
        }
    }

    let px_center = |p: usize| -> (f64, f64) { ((p % width) as f64 + 0.5, (p / width) as f64 + 0.5) };
    let lonlat = |(x, y): (f64, f64)| -> (f64, f64) { (x / width as f64 * 360.0 - 180.0, 90.0 - y / height as f64 * 180.0) };
    let haversine = |a: (f64, f64), b: (f64, f64)| -> f64 {
        let (la1, la2) = (a.1.to_radians(), b.1.to_radians());
        let dlat = la2 - la1;
        let dlon = (b.0 - a.0).to_radians();
        let h = (dlat / 2.0).sin().powi(2) + la1.cos() * la2.cos() * (dlon / 2.0).sin().powi(2);
        2.0 * radius_km * h.sqrt().asin()
    };
    let path_km = |pixels: &[usize]| -> f64 { pixels.windows(2).map(|p| haversine(lonlat(px_center(p[0])), lonlat(px_center(p[1])))).sum() };

    let node_count = cluster_pixels.len();
    let mut adjacency: Vec<Vec<usize>> = vec![Vec::new(); node_count];
    for (i, e) in edges.iter().enumerate() {
        adjacency[e.a].push(i);
        if e.b != e.a {
            adjacency[e.b].push(i);
        }
    }
    let alive_degree = |adjacency: &Vec<Vec<usize>>, edges: &Vec<Edge>, n: usize| adjacency[n].iter().filter(|&&e| edges[e].alive).count();

    // prune short spurs hanging off junctions
    loop {
        let mut pruned = false;
        for i in 0..edges.len() {
            if !edges[i].alive || edges[i].pixels.len() as f64 > options.prune_px {
                continue;
            }
            let (da, db) = (alive_degree(&adjacency, &edges, edges[i].a), alive_degree(&adjacency, &edges, edges[i].b));
            if (da == 1 && db >= 3) || (db == 1 && da >= 3) {
                edges[i].alive = false;
                pruned = true;
            }
        }
        if !pruned {
            break;
        }
    }
    // join edges through nodes that now have exactly two edges
    for n in 0..node_count {
        let live: Vec<usize> = adjacency[n].iter().copied().filter(|&e| edges[e].alive).collect();
        if live.len() != 2 || live[0] == live[1] {
            continue;
        }
        let (e1, e2) = (live[0], live[1]);
        let first_end = if edges[e1].b == n { edges[e1].a } else { edges[e1].b };
        let second_end = if edges[e2].a == n { edges[e2].b } else { edges[e2].a };
        if first_end == n || second_end == n {
            continue;
        }
        let mut first = std::mem::take(&mut edges[e1].pixels);
        if edges[e1].a == n {
            first.reverse(); // now runs first_end → n
        }
        let mut second = std::mem::take(&mut edges[e2].pixels);
        if edges[e2].b == n {
            second.reverse(); // now runs n → second_end
        }
        first.extend(second.into_iter().skip(1));
        edges[e2].alive = false;
        edges[e1] = Edge { a: first_end, b: second_end, pixels: first, alive: true };
        adjacency[second_end].retain(|&e| e != e2);
        adjacency[second_end].push(e1);
        adjacency[n].clear();
    }

    let node_pos: Vec<(f64, f64)> = cluster_pixels
        .iter()
        .map(|ps| {
            let (sx, sy) = ps.iter().fold((0.0, 0.0), |acc, &p| {
                let c = px_center(p);
                (acc.0 + c.0, acc.1 + c.1)
            });
            (sx / ps.len() as f64, sy / ps.len() as f64)
        })
        .collect();
    let node_height = |n: usize| -> f32 {
        let (lon, lat) = lonlat(node_pos[n]);
        match terrain {
            Some(map) => map.sample(lon, lat),
            None => 0.0,
        }
    };
    let edge_km: Vec<f64> = edges.iter().map(|e| if e.alive { path_km(&e.pixels) } else { 0.0 }).collect();
    let edge_flow = |e: &Edge| -> f32 { e.pixels.iter().map(|&p| values[p]).sum::<f32>() / e.pixels.len().max(1) as f32 };

    let mut rivers: Vec<RiverLine> = Vec::new();
    let mut seen = vec![false; node_count];
    for start in 0..node_count {
        if seen[start] || alive_degree(&adjacency, &edges, start) == 0 {
            continue;
        }
        // the component and its leaves
        let mut component = Vec::new();
        let mut stack = vec![start];
        seen[start] = true;
        while let Some(n) = stack.pop() {
            component.push(n);
            for &e in &adjacency[n] {
                if !edges[e].alive {
                    continue;
                }
                let other = if edges[e].a == n { edges[e].b } else { edges[e].a };
                if !seen[other] {
                    seen[other] = true;
                    stack.push(other);
                }
            }
        }
        let leaves: Vec<usize> = component.iter().copied().filter(|&n| alive_degree(&adjacency, &edges, n) == 1).collect();
        let Some(&mouth) = leaves.iter().min_by(|&&a, &&b| node_height(a).partial_cmp(&node_height(b)).unwrap()) else {
            continue; // a closed loop, no river
        };

        // tree from the mouth upwards
        let mut children: HashMap<usize, Vec<(usize, usize)>> = HashMap::new();
        let mut order = vec![mouth];
        let mut visited: HashSet<usize> = HashSet::from([mouth]);
        let mut i = 0;
        while i < order.len() {
            let n = order[i];
            i += 1;
            for &e in &adjacency[n] {
                if !edges[e].alive {
                    continue;
                }
                let other = if edges[e].a == n { edges[e].b } else { edges[e].a };
                if visited.insert(other) {
                    children.entry(n).or_default().push((e, other));
                    order.push(other);
                }
            }
        }
        let mut longest: HashMap<usize, f64> = HashMap::new();
        let mut network: HashMap<usize, f64> = HashMap::new();
        for &n in order.iter().rev() {
            let (mut best, mut sum) = (0.0f64, 0.0f64);
            for &(e, c) in children.get(&n).map(|v| v.as_slice()).unwrap_or(&[]) {
                best = best.max(edge_km[e] + longest[&c]);
                sum += edge_km[e] + network[&c];
            }
            longest.insert(n, best);
            network.insert(n, sum);
        }

        // main stem first, every side branch becomes a tributary of the river it leaves
        let best_child = |n: usize| -> Option<(usize, usize)> {
            children.get(&n).and_then(|kids| {
                kids.iter()
                    .copied()
                    .max_by(|a, b| (edge_km[a.0] + longest[&a.1]).partial_cmp(&(edge_km[b.0] + longest[&b.1])).unwrap())
            })
        };
        let mut work: Vec<(usize, Option<(usize, usize)>, Option<usize>)> = vec![(mouth, None, None)];
        while let Some((from, forced, parent)) = work.pop() {
            let mut cur = from;
            let mut pixels: Vec<usize> = Vec::new();
            let mut km = 0.0;
            let mut flow_sum = 0.0f32;
            let mut flow_n = 0usize;
            let index = rivers.len();
            let mut side: Vec<(usize, (usize, usize))> = Vec::new();
            let upstream = match forced {
                Some((e, c)) => edge_km[e] + network[&c],
                None => network[&from],
            };
            let mut step = forced.or_else(|| best_child(from));
            while let Some((e, next)) = step {
                // at the start of a tributary the other branches belong to the river it leaves
                if !(cur == from && forced.is_some()) {
                    for &kid in children.get(&cur).map(|v| v.as_slice()).unwrap_or(&[]) {
                        if kid.1 != next {
                            side.push((cur, kid));
                        }
                    }
                }
                let mut run = edges[e].pixels.clone();
                if edges[e].a != cur {
                    run.reverse();
                }
                if !pixels.is_empty() {
                    run.remove(0);
                }
                pixels.extend(run);
                km += edge_km[e];
                flow_sum += edge_flow(&edges[e]) * edges[e].pixels.len() as f32;
                flow_n += edges[e].pixels.len();
                cur = next;
                step = best_child(cur);
            }
            if pixels.len() < 2 {
                continue;
            }
            pixels.reverse(); // source → mouth
            let line: Vec<(f64, f64)> = simplify_line(&pixels.iter().map(|&p| px_center(p)).collect::<Vec<_>>(), options.simplify_px);
            let coords = line
                .into_iter()
                .map(|p| {
                    let (lon, lat) = lonlat(p);
                    [(lon * 1e5).round() / 1e5, (lat * 1e5).round() / 1e5]
                })
                .collect();
            rivers.push(RiverLine {
                index,
                parent,
                coords,
                length_km: km,
                upstream_km: upstream,
                flow: if flow_n > 0 { flow_sum / flow_n as f32 } else { 0.0 },
            });
            for (junction, kid) in side {
                work.push((junction, Some(kid), Some(index)));
            }
        }
    }

    // drop short rivers, and with them everything that flows into them
    let mut keep = vec![false; rivers.len()];
    let mut renumber = vec![usize::MAX; rivers.len()];
    let mut kept: Vec<RiverLine> = Vec::new();
    for river in rivers {
        let parent_ok = river.parent.map(|p| keep[p]).unwrap_or(true);
        if parent_ok && river.length_km >= options.min_length_km {
            keep[river.index] = true;
            renumber[river.index] = kept.len();
            let parent = river.parent.map(|p| renumber[p]);
            kept.push(RiverLine { index: kept.len(), parent, ..river });
        }
    }
    Ok(RiverResult { rivers: kept, pixels, width, height })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn y_shaped_network() {
        // a stem from the bottom with two branches; no terrain, so the lowest leaf is arbitrary but
        // there must be one river plus one tributary
        let (w, h) = (64, 32);
        let mut v = vec![0f32; w * h];
        for y in 16..30 {
            v[y * w + 32] = 1.0;
        }
        for i in 0..12 {
            v[(15 - i) * w + 32 - i] = 1.0;
            v[(15 - i) * w + 32 + i] = 1.0;
        }
        let options = RiverOptions { path: String::new(), threshold: 0.5, min_length_km: 0.0, simplify_px: 0.5, prune_px: 2.0, crop_square: false };
        let result = extract(&v, w, h, &options, None, 6606.727).unwrap();
        assert_eq!(result.rivers.len(), 2, "{:?}", result.rivers);
        assert!(result.rivers[1].parent == Some(0));
    }
}
