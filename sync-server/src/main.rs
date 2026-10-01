//! A small sync store. Everything a client sends under one secret code (its "space") is kept as
//! named items with a revision each; the apps decide what an item means. The server only
//! - finds the space by a hash of the code (the code itself is never stored),
//! - refuses a write that does not build on the current revision (409), so no device silently
//!   overwrites another,
//! - keeps the last few revisions of every item.
//!
//! Configuration by environment, see README.md.

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

/// a code shorter than this is refused: it is the only thing guarding the data
const MIN_CODE: usize = 24;
const MAX_CODE: usize = 512;

struct Config {
    data: PathBuf,
    port: u16,
    max_item: usize,
    max_space: u64,
    max_spaces: usize,
    history: usize,
    /// sha256 of SYNC_SERVER_KEY: without it, no new space can be made
    server_key: Option<[u8; 32]>,
}

struct App {
    config: Config,
    /// one writer at a time; this is a store for a handful of devices, not a database
    write: Mutex<()>,
}

type Shared = Arc<App>;

#[derive(Serialize, Deserialize, Clone)]
struct Meta {
    rev: u64,
    size: u64,
    sha256: String,
    /// unix milliseconds
    updated: u64,
    content_type: String,
}

#[derive(Serialize)]
struct Listed {
    name: String,
    #[serde(flatten)]
    meta: Meta,
}

// ---------------------------------------------------------------------------------------------
// errors

struct ApiError(StatusCode, serde_json::Value);

impl ApiError {
    fn new(status: StatusCode, message: &str) -> Self {
        ApiError(status, serde_json::json!({ "error": message }))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(self.1)).into_response()
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        eprintln!("io error: {error}");
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "storage error")
    }
}

type ApiResult<T> = Result<T, ApiError>;

// ---------------------------------------------------------------------------------------------
// helpers

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// compares without an early exit, so the time taken says nothing about the key
fn same(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// the folder of the space the code opens; the folder name is a hash, never the code
fn space_dir(app: &App, headers: &HeaderMap) -> ApiResult<PathBuf> {
    let code = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "missing code (Authorization: Bearer <code>)"))?;
    if code.len() < MIN_CODE || code.len() > MAX_CODE {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, &format!("the code must have {MIN_CODE} to {MAX_CODE} characters")));
    }
    let mut hasher = Sha256::new();
    hasher.update(b"sync-space\0");
    hasher.update(code.as_bytes());
    Ok(app.config.data.join("spaces").join(hex::encode(hasher.finalize())))
}

/// item names: letters, digits, dot, dash, underscore; no path tricks
fn checked_name(name: &str) -> ApiResult<&str> {
    let ok = !name.is_empty()
        && name.len() <= 128
        && !name.starts_with('.')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_');
    if ok { Ok(name) } else { Err(ApiError::new(StatusCode::BAD_REQUEST, "item names use letters, digits, '.', '-' and '_' (max. 128)")) }
}

/// "If-Match: \"41\"" → Some(41); "*" → None (any); absent → error
fn expected_rev(headers: &HeaderMap) -> ApiResult<Option<u64>> {
    let raw = headers
        .get(header::IF_MATCH)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::new(StatusCode::PRECONDITION_REQUIRED, "If-Match required: the revision the change builds on (\"0\" for a new item, * to overwrite)"))?
        .trim();
    if raw == "*" {
        return Ok(None);
    }
    raw.trim_start_matches("W/").trim_matches('"').parse::<u64>().map(Some).map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "If-Match must be a revision number"))
}

fn etag(rev: u64) -> HeaderValue {
    HeaderValue::from_str(&format!("\"{rev}\"")).unwrap()
}

async fn read_meta(item: &FsPath) -> ApiResult<Option<Meta>> {
    match tokio::fs::read(item.join("meta.json")).await {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).map_err(|e| std::io::Error::other(e.to_string()))?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// written beside the target, flushed to the disk, then renamed over it
fn write_atomic(path: &FsPath, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let temp = path.with_extension("tmp");
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, path)
}

fn dir_size(path: &FsPath) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            _ => e.metadata().map(|m| m.len()).unwrap_or(0),
        })
        .sum()
}

fn item_headers(meta: &Meta) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::ETAG, etag(meta.rev));
    headers.insert("x-revision", HeaderValue::from(meta.rev));
    headers.insert("x-updated", HeaderValue::from(meta.updated));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(v) = HeaderValue::from_str(&meta.content_type) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    headers
}

// ---------------------------------------------------------------------------------------------
// handlers

async fn health() -> &'static str {
    "ok"
}

/// all items of the space; an unknown code simply has none
async fn list(State(app): State<Shared>, headers: HeaderMap) -> ApiResult<Json<Vec<Listed>>> {
    let space = space_dir(&app, &headers)?;
    let mut out = Vec::new();
    let mut entries = match tokio::fs::read_dir(space.join("items")).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Json(out)),
        Err(e) => return Err(e.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(meta) = read_meta(&entry.path()).await? {
            out.push(Listed { name, meta });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(Json(out))
}

/// the current revision; If-None-Match with it answers 304, so polling costs next to nothing
async fn get_item(State(app): State<Shared>, Path(name): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let item = space_dir(&app, &headers)?.join("items").join(checked_name(&name)?);
    let meta = read_meta(&item).await?.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such item"))?;
    let unchanged = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim_start_matches("W/").trim_matches('"') == meta.rev.to_string());
    if unchanged {
        return Ok((StatusCode::NOT_MODIFIED, item_headers(&meta)).into_response());
    }
    let body = tokio::fs::read(item.join("revs").join(format!("{}.bin", meta.rev))).await?;
    Ok((item_headers(&meta), body).into_response())
}

/// a new revision, only if it builds on the current one
async fn put_item(State(app): State<Shared>, Path(name): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let space = space_dir(&app, &headers)?;
    let name = checked_name(&name)?.to_owned();
    let expected = expected_rev(&headers)?;
    let content_type = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_owned();
    let _guard = app.write.lock().await;

    if !tokio::fs::try_exists(&space).await? {
        if let Some(key) = &app.config.server_key {
            let given = headers.get("x-server-key").and_then(|v| v.to_str().ok()).map(|v| sha256(v.trim().as_bytes()));
            if !given.is_some_and(|g| same(&g, key)) {
                return Err(ApiError::new(StatusCode::FORBIDDEN, "new spaces need the server key (X-Server-Key)"));
            }
        }
        let spaces = std::fs::read_dir(app.config.data.join("spaces")).map(|d| d.count()).unwrap_or(0);
        if spaces >= app.config.max_spaces {
            return Err(ApiError::new(StatusCode::INSUFFICIENT_STORAGE, "no room for another space"));
        }
    }

    let item = space.join("items").join(&name);
    let current = read_meta(&item).await?;
    let current_rev = current.as_ref().map_or(0, |m| m.rev);
    if let Some(expected) = expected {
        if expected != current_rev {
            let mut response = ApiError(
                StatusCode::CONFLICT,
                serde_json::json!({ "error": "conflict: the item changed since", "rev": current_rev, "updated": current.as_ref().map(|m| m.updated) }),
            )
            .into_response();
            response.headers_mut().insert(header::ETAG, etag(current_rev));
            return Ok(response);
        }
    }

    let space_for_size = space.clone();
    let used = tokio::task::spawn_blocking(move || dir_size(&space_for_size)).await.unwrap_or(0);
    if used + body.len() as u64 > app.config.max_space {
        return Err(ApiError::new(StatusCode::INSUFFICIENT_STORAGE, "the space is full; delete items or raise SYNC_MAX_SPACE_MB"));
    }

    let meta = Meta { rev: current_rev + 1, size: body.len() as u64, sha256: hex::encode(sha256(&body)), updated: now_ms(), content_type };
    let history = app.config.history;
    let saved = meta.clone();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let revs = item.join("revs");
        std::fs::create_dir_all(&revs)?;
        write_atomic(&revs.join(format!("{}.bin", saved.rev)), &body)?;
        // the meta file is what makes the new revision current
        write_atomic(&item.join("meta.json"), &serde_json::to_vec(&saved).map_err(|e| std::io::Error::other(e.to_string()))?)?;
        // only the newest revisions stay
        let mut old: Vec<u64> = std::fs::read_dir(&revs)?
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".bin")?.parse().ok())
            .collect();
        old.sort_unstable();
        let excess = old.len().saturating_sub(history.max(1));
        for rev in &old[..excess] {
            let _ = std::fs::remove_file(revs.join(format!("{rev}.bin")));
        }
        Ok(())
    })
    .await
    .map_err(|_| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "write failed"))??;

    let status = if current.is_some() { StatusCode::OK } else { StatusCode::CREATED };
    Ok((status, item_headers(&meta), Json(meta)).into_response())
}

/// removes an item with its history; also needs the revision it was looked at
async fn delete_item(State(app): State<Shared>, Path(name): Path<String>, headers: HeaderMap) -> ApiResult<StatusCode> {
    let item = space_dir(&app, &headers)?.join("items").join(checked_name(&name)?);
    let expected = expected_rev(&headers)?;
    let _guard = app.write.lock().await;
    let meta = read_meta(&item).await?.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "no such item"))?;
    if expected.is_some_and(|e| e != meta.rev) {
        return Err(ApiError(StatusCode::CONFLICT, serde_json::json!({ "error": "conflict: the item changed since", "rev": meta.rev })));
    }
    tokio::fs::remove_dir_all(&item).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// the kept revisions, newest first
async fn history(State(app): State<Shared>, Path(name): Path<String>, headers: HeaderMap) -> ApiResult<Json<Vec<serde_json::Value>>> {
    let revs = space_dir(&app, &headers)?.join("items").join(checked_name(&name)?).join("revs");
    let mut out = Vec::new();
    let mut entries = match tokio::fs::read_dir(&revs).await {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ApiError::new(StatusCode::NOT_FOUND, "no such item")),
        Err(e) => return Err(e.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        let Some(rev) = entry.file_name().to_str().and_then(|n| n.strip_suffix(".bin")).and_then(|n| n.parse::<u64>().ok()) else { continue };
        let metadata = entry.metadata().await?;
        let modified = metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
        out.push(serde_json::json!({ "rev": rev, "size": metadata.len(), "updated": modified }));
    }
    out.sort_by_key(|v| std::cmp::Reverse(v["rev"].as_u64()));
    Ok(Json(out))
}

async fn history_rev(State(app): State<Shared>, Path((name, rev)): Path<(String, u64)>, headers: HeaderMap) -> ApiResult<Response> {
    let path = space_dir(&app, &headers)?.join("items").join(checked_name(&name)?).join("revs").join(format!("{rev}.bin"));
    match tokio::fs::read(&path).await {
        Ok(body) => Ok(([(header::ETAG, etag(rev))], body).into_response()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(ApiError::new(StatusCode::NOT_FOUND, "this revision is not kept")),
        Err(e) => Err(e.into()),
    }
}

// ---------------------------------------------------------------------------------------------
// start

fn env_num<T: std::str::FromStr>(name: &str, fallback: T) -> T {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(fallback)
}

fn config() -> Config {
    let key = std::env::var("SYNC_SERVER_KEY").ok().map(|k| k.trim().to_owned()).filter(|k| !k.is_empty());
    Config {
        data: PathBuf::from(std::env::var("SYNC_DATA").unwrap_or_else(|_| "/data".into())),
        port: env_num("SYNC_PORT", 8080),
        max_item: env_num::<usize>("SYNC_MAX_ITEM_MB", 64) * 1024 * 1024,
        max_space: env_num::<u64>("SYNC_MAX_SPACE_MB", 1024) * 1024 * 1024,
        max_spaces: env_num("SYNC_MAX_SPACES", 100),
        history: env_num("SYNC_HISTORY", 20),
        server_key: key.map(|k| sha256(k.as_bytes())),
    }
}

/// `sync-server healthcheck`: for the container's health check (the image has no curl)
fn healthcheck(port: u16) -> std::process::ExitCode {
    use std::io::{Read, Write};
    let ok = (|| -> std::io::Result<bool> {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))?;
        stream.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
        stream.write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut reply = String::new();
        stream.read_to_string(&mut reply)?;
        Ok(reply.starts_with("HTTP/1.1 200"))
    })()
    .unwrap_or(false);
    if ok { std::process::ExitCode::SUCCESS } else { std::process::ExitCode::FAILURE }
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut signal) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

fn main() -> std::process::ExitCode {
    let config = config();
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck(config.port);
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("runtime").block_on(serve(config))
}

async fn serve(config: Config) -> std::process::ExitCode {
    if let Err(e) = std::fs::create_dir_all(config.data.join("spaces")) {
        eprintln!("cannot use the data folder {}: {e}", config.data.display());
        return std::process::ExitCode::FAILURE;
    }
    println!(
        "sync-server {} on port {}, data in {}, items up to {} MB, spaces up to {} MB, {} revisions kept, server key {}",
        env!("CARGO_PKG_VERSION"),
        config.port,
        config.data.display(),
        config.max_item / 1024 / 1024,
        config.max_space / 1024 / 1024,
        config.history,
        if config.server_key.is_some() { "required for new spaces" } else { "not set" },
    );
    let port = config.port;
    let max_item = config.max_item;
    let app = Arc::new(App { config, write: Mutex::new(()) });
    // the apps call from their own origins (tauri.localhost, veil.localhost …); there are no
    // cookies, the code travels in a header, so any origin may ask
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::HEAD, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE, header::IF_MATCH, header::IF_NONE_MATCH, "x-server-key".parse().unwrap()])
        .expose_headers([header::ETAG, "x-revision".parse().unwrap(), "x-updated".parse().unwrap()]);
    let router = Router::new()
        .route("/health", get(health))
        .route("/v1/items", get(list))
        .route("/v1/items/{name}", get(get_item).put(put_item).delete(delete_item))
        .route("/v1/items/{name}/history", get(history))
        .route("/v1/items/{name}/history/{rev}", get(history_rev))
        .layer(DefaultBodyLimit::max(max_item))
        .layer(cors)
        .with_state(app);
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("cannot listen on port {port}: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    match axum::serve(listener, router).with_graceful_shutdown(shutdown()).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("server stopped: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
