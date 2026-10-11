// The Obsidian vault is a folder of Markdown files. The editor reads it directly, but only inside
// the folder the user released.
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Serialize)]
pub struct VaultNote {
    /// vault-relative with forward slashes, including ".md"
    pub path: String,
    pub modified: u64,
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<VaultNote>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue; // .obsidian, .trash, .git
        }
        if path.is_dir() {
            walk(root, &path, out);
        } else if name.to_ascii_lowercase().ends_with(".md") {
            let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(VaultNote { path: relative, modified });
        }
    }
}

pub fn list(root: &str) -> Result<Vec<VaultNote>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("Der Vault-Ordner existiert nicht.".into());
    }
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    Ok(out)
}

/// resolves a vault-relative path and refuses anything that leaves the vault
pub fn resolve(root: &str, relative: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(root).map_err(|_| "Der Vault-Ordner existiert nicht.".to_string())?;
    let target = fs::canonicalize(root.join(relative)).map_err(|_| format!("Die Note „{relative}“ gibt es nicht."))?;
    if !target.starts_with(&root) {
        return Err("Der Pfad liegt außerhalb des Vaults.".into());
    }
    Ok(target)
}

pub fn read(root: &str, relative: &str) -> Result<String, String> {
    fs::read_to_string(resolve(root, relative)?).map_err(|e| e.to_string())
}

/// writes a Markdown note the editor makes; the path may only name folders below the vault, and the
/// file is written next to it first and then renamed, so a sync tool never sees half a note
pub fn write(root: &str, relative: &str, text: &str) -> Result<(), String> {
    let root = fs::canonicalize(root).map_err(|_| "Der Vault-Ordner existiert nicht.".to_string())?;
    let relative = Path::new(relative);
    let plain = relative.components().all(|c| matches!(c, Component::Normal(_)));
    let markdown = relative.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"));
    if !plain || !markdown {
        return Err("Nur eine .md-Note innerhalb des Vaults kann geschrieben werden.".into());
    }
    let target = root.join(relative);
    let folder = target.parent().ok_or("Ungültiger Pfad.")?;
    fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    if !fs::canonicalize(folder).map_err(|e| e.to_string())?.starts_with(&root) {
        return Err("Der Pfad liegt außerhalb des Vaults.".into());
    }
    let temp = folder.join(format!(".{}.tmp", target.file_name().unwrap_or_default().to_string_lossy()));
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    fs::rename(&temp, &target).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })
}
