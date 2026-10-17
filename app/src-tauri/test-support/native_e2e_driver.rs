//! Opt-in native backend process used exclusively by tests/native_e2e.rs.
fn main() {
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some("--ipc-stack") {
        app_lib::native_e2e::ipc::run().expect("isolated IPC fixture failed");
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("native E2E runtime");
    if let Err(error) = runtime.block_on(app_lib::native_e2e::run()) {
        eprintln!("Native E2E driver failed: {error}");
        std::process::exit(1);
    }
}
