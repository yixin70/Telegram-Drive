//! Real Windows Wry IPC in a separate process with no login, plugins or production profile.
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};
use tauri::Manager;

pub fn run() -> Result<(), String> {
    let root = PathBuf::from(std::env::args().nth(2).ok_or("missing fixture root")?);
    if !root.is_absolute()
        || std::fs::read_to_string(root.join(".native-e2e-fixture"))
            .ok()
            .as_deref()
            != Some("telegram-drive-synthetic-e2e\n")
    {
        return Err("IPC requires a private native fixture".into());
    }
    // The optional WebDAV journey reuses the same isolated Wry process and real
    // production invoke dispatcher, but adds only the states the WebDAV restart
    // path needs. It never loads the production profile, keyring, session,
    // network bootstrap or frontend.
    let webdav = root.join(".ipc-webdav-fixture").is_file();
    let identifier = if webdav {
        isolated_identifier(&root)?
    } else {
        format!("com.telegramdrive.ipc-e2e.{}", uuid::Uuid::new_v4())
    };
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = identifier.clone();
    context.config_mut().app.windows.clear();

    let mut builder = tauri::Builder::default()
        .manage((*super::disconnected()).clone())
        .manage(crate::db::init_db_at(&root)?);
    if webdav {
        builder = builder
            .manage(crate::WebDavServerLifecycle(
                crate::server_lifecycle::LocalServerLifecycle::new(),
            ))
            .manage(std::sync::Arc::new(crate::bandwidth::BandwidthManager::at(
                &root,
            )))
            .manage(std::sync::Arc::new(
                crate::vpn_optimizer::NetworkConfig::new(),
            ));
    }
    let (send, receive) = mpsc::channel();
    let handler = crate::invoke_handler();
    let app = builder
        .register_uri_scheme_protocol("ipc-stack", |_, _| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(b"<!doctype html><html><body>Isolated IPC fixture</body></html>".to_vec())
                .unwrap()
        })
        .invoke_handler(move |invoke| {
            if invoke.message.command() == "native_e2e_result" {
                if let tauri::ipc::InvokeBody::Json(value) = invoke.message.payload() {
                    let _ = send.send(value.clone());
                }
                invoke.resolver.resolve(());
                true
            } else {
                handler(invoke)
            }
        })
        .build(context)
        .map_err(|error| error.to_string())?;

    if webdav {
        // A divergent, synthetic media state lets the journey prove the WebDAV
        // port validation still excludes the *actual* streaming port, without
        // booting the production media server.
        if let Some(port) = read_u16(&root.join("ipc-stream-port")) {
            crate::set_stream_port(port);
        }
        own_isolated_profile(app.handle(), &root, &identifier)?;
        // Fixture-only readiness failure *after* the fresh profile is owned and
        // before any WebView is ready, so the parent must still reap and clean.
        if root.join("ipc-fail-before-ready").is_file() {
            return Err("controlled readiness failure after profile ownership".into());
        }
    }

    // Never load the real frontend or its startup commands, session or keyring.
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External("ipc-stack://localhost".parse().unwrap()),
    )
    .visible(false)
    .data_directory(root.join("webview"))
    .initialization_script("window.addEventListener('DOMContentLoaded', () => window.__TAURI_INTERNALS__.invoke('native_e2e_result', {ready:true}));")
    .build()
    .map_err(|error| error.to_string())?;
    let webview = window.as_ref().clone();
    let handle = app.handle().clone();
    let worker = std::thread::Builder::new().name("ipc-requests".into())
        .spawn(move || {
          let result = (|| -> Result<(), String> {
            let ready = receive.recv_timeout(Duration::from_secs(30)).map_err(|e| e.to_string())?;
            if ready["ready"] != true { return Err("unexpected WebView readiness reply".into()); }
            println!("{}", json!({"ready": true}));
            std::io::stdout().flush().map_err(|error| error.to_string())?;
            for line in std::io::stdin().lock().lines() {
                let request: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                let command = request["command"].as_str().ok_or("missing command")?;
                if command == "shutdown" { break; }
                if !allowed_command(webdav, command) {
                    return Err("command outside the isolated IPC journey".into());
                }
                let command = serde_json::to_string(command).map_err(|e| e.to_string())?;
                let payload = request.get("payload").cloned().unwrap_or_else(|| json!({}));
                webview.eval(format!("window.__TAURI_INTERNALS__.invoke({command}, {payload}).then(value => window.__TAURI_INTERNALS__.invoke('native_e2e_result', {{ok:true,value}}), error => window.__TAURI_INTERNALS__.invoke('native_e2e_result', {{ok:false,error}}));")).map_err(|e| e.to_string())?;
                let reply = receive.recv_timeout(Duration::from_secs(15)).map_err(|e| e.to_string())?;
                println!("{reply}");
                std::io::stdout().flush().map_err(|error| error.to_string())?;
            }
            Ok(())
          })();
          handle.exit(if result.is_ok() { 0 } else { 1 });
          result
        }).map_err(|e| e.to_string())?;
    // No production setup/exit hooks are installed in this fixture.
    app.run_return(|_, _| {});
    worker.join().map_err(|_| "IPC worker panicked")?
}

/// The two isolated journeys allow exactly the commands they drive through the
/// real production invoke dispatcher.
fn allowed_command(webdav: bool, command: &str) -> bool {
    if webdav {
        matches!(
            command,
            "cmd_get_webdav_settings"
                | "cmd_regenerate_webdav_token"
                | "cmd_update_webdav_settings"
        )
    } else {
        matches!(
            command,
            "cmd_scan_folders"
                | "cmd_get_files"
                | "cmd_get_encryption_settings"
                | "cmd_update_encryption_settings"
                | "cmd_get_api_settings"
                | "cmd_update_api_settings"
                | "cmd_regenerate_api_key"
                | "not_a_command"
        )
    }
}

fn read_u16(path: &Path) -> Option<u16> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// The parent pre-creates the exact random identifier, so the child cannot gain
/// cleanup authority from an arbitrary post-hoc identity of its own choosing.
fn isolated_identifier(root: &Path) -> Result<String, String> {
    let value = std::fs::read_to_string(root.join("ipc-identifier"))
        .map_err(|error| error.to_string())?
        .trim()
        .to_string();
    let suffix = value
        .strip_prefix("com.telegramdrive.ipc-webdav-e2e.")
        .unwrap_or("");
    let safe = !suffix.is_empty()
        && suffix.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'));
    if !safe {
        return Err("unexpected isolated WebDAV identifier".into());
    }
    Ok(value)
}

/// Validate and then create only freshly named, identifier-leaf Tauri profile
/// directories, recording each created leaf incrementally for the parent. Every
/// path is fail-closed: a preexisting leaf (even empty), a missing parent, or a
/// symlink/reparse point anywhere on the chain rejects the whole run before the
/// WebView becomes ready. Tauri's desktop resolvers only join base + identifier,
/// so a fresh nonce can never legitimately find an existing directory here.
fn own_isolated_profile<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    root: &Path,
    identifier: &str,
) -> Result<(), String> {
    let nonce = std::fs::read_to_string(root.join("ipc-nonce"))
        .map_err(|error| error.to_string())?
        .trim()
        .to_string();
    let safe_nonce = nonce.len() == 32
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'));
    if !safe_nonce {
        return Err("unexpected isolated WebDAV nonce".into());
    }
    let resolved = [
        ("appData", app.path().app_data_dir()),
        ("appLocal", app.path().app_local_data_dir()),
        ("appConfig", app.path().app_config_dir()),
        ("appCache", app.path().app_cache_dir()),
    ];
    // Phase one: validate every resolved leaf before creating anything.
    let mut leaves: Vec<(bool, PathBuf)> = Vec::new();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for (label, result) in resolved {
        let path = result.map_err(|error| format!("{label} resolver failed: {error}"))?;
        validate_isolated_leaf(&path, identifier)?;
        let parent = path.parent().ok_or("isolated profile path has no parent")?;
        let key = parent
            .canonicalize()
            .map_err(|error| format!("isolated profile parent cannot be resolved: {error}"))?
            .join(identifier);
        if !seen.insert(key) {
            continue;
        }
        leaves.push((label == "appData", path));
    }
    // Phase two: create only the validated fresh leaves and record ownership.
    let mut owned: Vec<PathBuf> = Vec::new();
    let mut app_data: Option<PathBuf> = None;
    for (is_app_data, path) in leaves {
        std::fs::create_dir(&path)
            .map_err(|error| format!("isolated profile create failed for {path:?}: {error}"))?;
        write_owner_marker(&path, &nonce)?;
        owned.push(path.clone());
        if is_app_data {
            app_data = Some(path);
        }
        write_manifest(root, identifier, &nonce, app_data.as_deref(), &owned)?;
    }
    write_manifest(root, identifier, &nonce, app_data.as_deref(), &owned)
}

/// A resolved leaf must be absolute, named exactly for the identifier, absent,
/// and sit under an existing chain of real directories. Metadata errors other
/// than a missing leaf reject; a missing leaf is the only acceptable state.
fn validate_isolated_leaf(path: &Path, identifier: &str) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("isolated profile path is not absolute".into());
    }
    if path.file_name().and_then(|value| value.to_str()) != Some(identifier) {
        return Err("resolved Tauri path is not isolated".into());
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if is_reparse_point(&metadata) {
                return Err("isolated profile path is a reparse point".into());
            }
            return Err("isolated profile path already exists".into());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("isolated profile path metadata failed: {error}")),
    }
    let mut current = path.parent();
    while let Some(directory) = current {
        let metadata = std::fs::symlink_metadata(directory)
            .map_err(|error| format!("isolated profile ancestor metadata failed: {error}"))?;
        if is_reparse_point(&metadata) {
            return Err("isolated profile ancestor is a reparse point".into());
        }
        if !metadata.is_dir() {
            return Err("isolated profile ancestor is not a directory".into());
        }
        current = directory.parent();
    }
    Ok(())
}

/// A symlink or a Windows reparse point (`FILE_ATTRIBUTE_REPARSE_POINT`) can
/// redirect a profile path elsewhere, so both are rejected.
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// The ownership marker is created exclusively (`create_new`) as a regular file,
/// so an existing file can never be silently adopted or followed.
fn write_owner_marker(path: &Path, nonce: &str) -> Result<(), String> {
    let mut marker = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path.join("ipc-e2e-owner"))
        .map_err(|error| format!("isolated ownership marker failed: {error}"))?;
    marker
        .write_all(format!("{nonce}\n").as_bytes())
        .map_err(|error| format!("isolated ownership marker write failed: {error}"))
}

fn write_manifest(
    root: &Path,
    identifier: &str,
    nonce: &str,
    app_data: Option<&Path>,
    owned: &[PathBuf],
) -> Result<(), String> {
    let record = json!({
        "identifier": identifier,
        "nonce": nonce,
        "appData": app_data.map(|path| path.to_string_lossy().into_owned()),
        "paths": owned
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
    });
    std::fs::write(
        root.join("ipc-profile.json"),
        serde_json::to_vec(&record).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}
