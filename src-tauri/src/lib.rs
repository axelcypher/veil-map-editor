// Desktop side of the editor: file access and the heavy raster work. The frontend holds all editing
// logic and reaches this through its platform adapter, so a web build can swap it out.
mod coast;
mod heightmap;
mod koppen;
mod raster;
mod rivers;
mod vault;
#[cfg(test)]
mod probe_tests;

use heightmap::{Heightmap, ImportOptions, ImportReport, TerrainMeta};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

struct AppState {
    cache_root: PathBuf,
    terrain: Mutex<Option<Arc<Heightmap>>>,
    /// files the user picked (city plans, textures) that the page may load through the protocol
    files: Mutex<HashMap<String, PathBuf>>,
}

#[derive(serde::Serialize, Clone)]
struct Progress {
    stage: String,
    fraction: f32,
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    async move { tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())? }
}

#[tauri::command]
async fn terrain_import(app: tauri::AppHandle, options: serde_json::Value, radius_m: f64) -> Result<ImportReport, String> {
    let options: ImportOptions = serde_json::from_value(options).map_err(|e| e.to_string())?;
    let cache_root = app.state::<AppState>().cache_root.clone();
    let handle = app.clone();
    let (report, map) = blocking(move || {
        let progress = |stage: &str, fraction: f32| {
            let _ = handle.emit("progress", Progress { stage: stage.into(), fraction });
        };
        progress("Datei lesen und prüfen", 0.0);
        let (checks, source, map) = heightmap::run_checks(&options);
        let failed = checks.iter().any(|c| c.status == "error");
        let Some(map) = map.filter(|_| !failed) else {
            return Ok((ImportReport { ok: false, source, checks, meta: None }, None));
        };
        let hash = raster::file_hash(Path::new(&options.path))?;
        let meta = heightmap::build_cache(&map, &options, &hash, radius_m, &cache_root, &progress)?;
        Ok((ImportReport { ok: true, source, checks, meta: Some(meta) }, Some(Arc::new(map))))
    })
    .await?;
    if let Some(map) = map {
        *app.state::<AppState>().terrain.lock().unwrap() = Some(map);
    }
    Ok(report)
}

#[tauri::command]
async fn terrain_open(app: tauri::AppHandle, id: String) -> Result<TerrainMeta, String> {
    let cache_root = app.state::<AppState>().cache_root.clone();
    let (meta, map) = blocking(move || heightmap::load_cached(&cache_root, &id)).await?;
    *app.state::<AppState>().terrain.lock().unwrap() = Some(Arc::new(map));
    Ok(meta)
}

#[tauri::command]
fn terrain_close(state: State<AppState>) {
    *state.terrain.lock().unwrap() = None;
}

#[tauri::command]
fn terrain_heights(state: State<AppState>, points: Vec<[f64; 2]>) -> Vec<Option<f32>> {
    let terrain = state.terrain.lock().unwrap().clone();
    points.iter().map(|p| terrain.as_ref().map(|t| t.sample(p[0], p[1]))).collect()
}

#[tauri::command]
async fn rivers_import(app: tauri::AppHandle, options: serde_json::Value, radius_m: f64) -> Result<rivers::RiverResult, String> {
    let options: rivers::RiverOptions = serde_json::from_value(options).map_err(|e| e.to_string())?;
    let terrain = app.state::<AppState>().terrain.lock().unwrap().clone();
    let handle = app.clone();
    blocking(move || {
        let _ = handle.emit("progress", Progress { stage: "Maske lesen".into(), fraction: 0.05 });
        let (mut values, info) = raster::read_luma(Path::new(&options.path))?;
        let (mut width, mut height) = (info.width, info.height);
        if options.crop_square && width == height {
            let (cropped, w, h) = raster::crop_square_middle(&values, width, height)?;
            values = cropped;
            width = w;
            height = h;
        }
        raster::check_ratio(width, height)?;
        let _ = handle.emit("progress", Progress { stage: "Flusslinien verfolgen".into(), fraction: 0.4 });
        let result = rivers::extract(&values, width, height, &options, terrain.as_deref(), radius_m / 1000.0)?;
        let _ = handle.emit("progress", Progress { stage: "Fertig".into(), fraction: 1.0 });
        Ok(result)
    })
    .await
}

#[tauri::command]
async fn koppen_import(app: tauri::AppHandle, options: serde_json::Value) -> Result<koppen::KoppenMeta, String> {
    let options: koppen::KoppenOptions = serde_json::from_value(options).map_err(|e| e.to_string())?;
    let terrain = app.state::<AppState>().terrain.lock().unwrap().clone();
    let cache_root = app.state::<AppState>().cache_root.clone();
    let handle = app.clone();
    blocking(move || {
        let _ = handle.emit("progress", Progress { stage: "Klimakarte einlesen".into(), fraction: 0.1 });
        let meta = koppen::import(&options, terrain.as_deref(), &cache_root)?;
        let _ = handle.emit("progress", Progress { stage: "Fertig".into(), fraction: 1.0 });
        Ok(meta)
    })
    .await
}

#[tauri::command]
async fn koppen_histogram(path: String) -> Result<Vec<(String, f32)>, String> {
    blocking(move || koppen::histogram(Path::new(&path), 48)).await
}

#[tauri::command]
fn vault_list(root: String) -> Result<Vec<vault::VaultNote>, String> {
    vault::list(&root)
}

#[tauri::command]
fn vault_read(root: String, path: String) -> Result<String, String> {
    vault::read(&root, &path)
}

#[tauri::command]
fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_text(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

/// lets the page load a file the user picked, by a token instead of its path
#[tauri::command]
fn register_file(state: State<AppState>, path: String) -> Result<String, String> {
    if !Path::new(&path).is_file() {
        return Err(format!("Datei nicht gefunden: {path}"));
    }
    let token = blake3::hash(path.as_bytes()).to_hex()[..16].to_string();
    state.files.lock().unwrap().insert(token.clone(), PathBuf::from(path));
    Ok(token)
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let allowed = ["obsidian://", "https://", "http://"];
    if !allowed.iter().any(|p| url.starts_with(p)) {
        return Err("Nur Obsidian- und Web-Links werden geöffnet.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("Datei nicht gefunden: {path}"));
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

fn serve(state: &AppState, uri_path: &str) -> Option<PathBuf> {
    let decoded = uri_path.trim_start_matches('/');
    if let Some(rest) = decoded.strip_prefix("cache/") {
        let relative = PathBuf::from(rest);
        if relative.components().any(|c| !matches!(c, Component::Normal(_))) {
            return None;
        }
        return Some(state.cache_root.join(relative));
    }
    if let Some(token) = decoded.strip_prefix("file/") {
        return state.files.lock().unwrap().get(token).cloned();
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_uri_scheme_protocol("veil", |context, request| {
            let state = context.app_handle().state::<AppState>();
            let response = tauri::http::Response::builder().header("Access-Control-Allow-Origin", "*");
            match serve(&state, request.uri().path()).and_then(|p| std::fs::read(&p).ok().map(|b| (p, b))) {
                Some((path, bytes)) => response
                    .header("Content-Type", content_type(&path))
                    .header("Cache-Control", "max-age=31536000")
                    .body(bytes)
                    .unwrap(),
                None => response.status(404).body(Vec::new()).unwrap(),
            }
        })
        .setup(|app| {
            let cache_root = app.path().app_cache_dir()?;
            std::fs::create_dir_all(&cache_root)?;
            app.manage(AppState { cache_root, terrain: Mutex::new(None), files: Mutex::new(HashMap::new()) });
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terrain_import,
            terrain_open,
            terrain_close,
            terrain_heights,
            rivers_import,
            koppen_import,
            koppen_histogram,
            vault_list,
            vault_read,
            read_text,
            write_text,
            file_exists,
            register_file,
            open_external,
            open_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
