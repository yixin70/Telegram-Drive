//! Real Windows Wry IPC in a separate process with no login, plugins or production profile.
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::mpsc,
    time::Duration,
};

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
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!("com.telegramdrive.ipc-e2e.{}", uuid::Uuid::new_v4());
    context.config_mut().app.windows.clear();
    let (send, receive) = mpsc::channel();
    let handler = crate::invoke_handler();
    let app = tauri::Builder::default()
        .manage((*super::disconnected()).clone())
        .manage(crate::db::init_db_at(&root)?)
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
                if !matches!(command, "cmd_scan_folders" | "cmd_get_files" | "cmd_get_encryption_settings" | "cmd_update_encryption_settings" | "not_a_command") {
                    return Err("command outside the isolated IPC journey".into());
                }
                let command = serde_json::to_string(command).map_err(|e| e.to_string())?;
                let payload = request.get("payload").cloned().unwrap_or_else(|| json!({}));
                webview.eval(&format!("window.__TAURI_INTERNALS__.invoke({command}, {payload}).then(value => window.__TAURI_INTERNALS__.invoke('native_e2e_result', {{ok:true,value}}), error => window.__TAURI_INTERNALS__.invoke('native_e2e_result', {{ok:false,error}}));")).map_err(|e| e.to_string())?;
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
