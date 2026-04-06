use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{AppHandle, Emitter, Listener, Manager, RunEvent, WebviewUrl, WebviewWindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

const BACKEND_HEALTH_PATH: &str = "/api/health";
const BACKEND_RESET_DB_PATH: &str = "/api/db/reset";
const BACKEND_SIDECAR_NAME: &str = "parlor-backend";
const BACKEND_MAX_WAIT_SECS: u64 = 60;
const BACKEND_START_RETRIES: usize = 6;

struct BackendState {
    child: Mutex<Option<CommandChild>>,
    started: AtomicBool,
    stopping: AtomicBool,
    current_port: Mutex<Option<u16>>,
    data_dir: PathBuf,
    logs_dir: PathBuf,
    log_file: Mutex<Option<File>>,
}

impl BackendState {
    fn new(app: &AppHandle) -> Result<Self, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| format!("app_data_dir failed: {err}"))?;
        fs::create_dir_all(&data_dir).map_err(|err| format!("create data dir failed: {err}"))?;

        let logs_dir = data_dir.join("logs");
        fs::create_dir_all(&logs_dir).map_err(|err| format!("create logs dir failed: {err}"))?;

        let log_path = logs_dir.join("backend.log");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .map_err(|err| format!("open backend log failed: {err}"))?;

        Ok(Self {
            child: Mutex::new(None),
            started: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            current_port: Mutex::new(None),
            data_dir,
            logs_dir,
            log_file: Mutex::new(Some(file)),
        })
    }

    fn log_backend_line(&self, prefix: &str, line: &str) {
        if let Ok(mut guard) = self.log_file.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = writeln!(file, "{}{}", prefix, line.trim_end());
            }
        }
    }
}

fn allocate_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|err| format!("port bind failed: {err}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| format!("port read failed: {err}"))
}

fn backend_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn open_path_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(path);
        c
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(path);
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(path);
        c
    };

    cmd.spawn()
        .map_err(|err| format!("failed to open {}: {err}", path.display()))?;
    Ok(())
}

fn stop_backend(state: &BackendState) {
    if state.stopping.swap(true, Ordering::SeqCst) {
        return;
    }

    let mut guard = state.child.lock().expect("backend child mutex poisoned");
    if let Some(child) = guard.as_mut() {
        println!("[backend] stopping backend process...");
        if let Err(err) = child.kill() {
            eprintln!("[backend] failed to stop backend: {err}");
        } else {
            println!("[backend] backend process stopped");
        }
    }

    *guard = None;
    if let Ok(mut port) = state.current_port.lock() {
        *port = None;
    }
    state.started.store(false, Ordering::SeqCst);
}

async fn wait_for_backend(port: u16) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("{}{BACKEND_HEALTH_PATH}", backend_base_url(port));

    let max_attempts = BACKEND_MAX_WAIT_SECS * 2;
    for attempt in 1..=max_attempts {
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                println!("[backend] health check ready at {url}");
                return Ok(());
            }
            Ok(resp) => {
                eprintln!(
                    "[backend] health check attempt {attempt}/{max_attempts} returned {}",
                    resp.status()
                );
            }
            Err(err) => {
                eprintln!("[backend] health check attempt {attempt}/{max_attempts} failed: {err}");
            }
        }

        tauri::async_runtime::sleep(Duration::from_millis(500)).await;
    }

    Err(format!(
        "backend did not become healthy within {} seconds",
        BACKEND_MAX_WAIT_SECS
    ))
}

fn spawn_backend_process(app: &AppHandle, port: u16) -> Result<(), String> {
    let state = app.state::<BackendState>();

    let mut command = tauri_plugin_shell::process::Command::new_sidecar(BACKEND_SIDECAR_NAME)
        .map_err(|err| format!("sidecar init failed: {err}"))?;

    command = command
        .env("PORT", port.to_string())
        .env("PARLOR_DATA_DIR", state.data_dir.display().to_string())
        .env("PARLOR_LOG_DIR", state.logs_dir.display().to_string());

    let (mut rx, child) = command
        .spawn()
        .map_err(|err| format!("backend spawn failed: {err}"))?;

    {
        let mut guard = state.child.lock().expect("backend child mutex poisoned");
        *guard = Some(child);
    }
    {
        let mut current = state
            .current_port
            .lock()
            .expect("backend port mutex poisoned");
        *current = Some(port);
    }
    state.stopping.store(false, Ordering::SeqCst);
    println!("[backend] backend process started on port {port}");

    let app_for_logs = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    if let Ok(line) = String::from_utf8(bytes) {
                        print!("[backend][stdout] {line}");
                        app_for_logs
                            .state::<BackendState>()
                            .log_backend_line("[stdout] ", &line);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if let Ok(line) = String::from_utf8(bytes) {
                        eprint!("[backend][stderr] {line}");
                        app_for_logs
                            .state::<BackendState>()
                            .log_backend_line("[stderr] ", &line);
                    }
                }
                CommandEvent::Error(error) => {
                    eprintln!("[backend][event-error] {error}");
                }
                CommandEvent::Terminated(payload) => {
                    let state = app_for_logs.state::<BackendState>();
                    let expected_stop = state.stopping.load(Ordering::SeqCst);
                    {
                        let mut guard = state.child.lock().expect("backend child mutex poisoned");
                        *guard = None;
                    }
                    {
                        let mut current = state
                            .current_port
                            .lock()
                            .expect("backend port mutex poisoned");
                        *current = None;
                    }
                    state.started.store(false, Ordering::SeqCst);

                    eprintln!("[backend] terminated: {payload:?}");
                    if !expected_stop {
                        app_for_logs
                            .emit("backend-crashed", "The local backend stopped unexpectedly.")
                            .ok();
                    }
                }
                _ => {}
            }
        }
    });

    Ok(())
}

async fn launch_backend_and_show_window(app: AppHandle) -> Result<(), String> {
    let mut last_error = String::new();

    for attempt in 1..=BACKEND_START_RETRIES {
        let port = allocate_port()?;
        println!("[backend] startup attempt {attempt}/{BACKEND_START_RETRIES} on port {port}");

        if let Err(err) = spawn_backend_process(&app, port) {
            last_error = err;
            continue;
        }

        match wait_for_backend(port).await {
            Ok(()) => {
                let main_window = app
                    .get_webview_window("main")
                    .ok_or_else(|| "main window not found".to_string())?;

                let url = backend_base_url(port);
                main_window
                    .navigate(WebviewUrl::External(
                        url.parse().map_err(|err| err.to_string())?,
                    ))
                    .map_err(|err| format!("navigate failed: {err}"))?;
                main_window
                    .show()
                    .map_err(|err| format!("window show failed: {err}"))?;
                main_window
                    .set_focus()
                    .map_err(|err| format!("window focus failed: {err}"))?;

                println!("[backend] main window opened at {url}");
                return Ok(());
            }
            Err(err) => {
                last_error = err;
                let state = app.state::<BackendState>();
                stop_backend(&state);
                tauri::async_runtime::sleep(Duration::from_millis(250)).await;
            }
        }
    }

    Err(format!(
        "Unable to start local backend after {} attempts. Last error: {}",
        BACKEND_START_RETRIES, last_error
    ))
}

async fn restart_backend(app: AppHandle) -> Result<(), String> {
    let state = app.state::<BackendState>();
    stop_backend(&state);

    let mut last_error = String::new();
    for attempt in 1..=BACKEND_START_RETRIES {
        let port = allocate_port()?;
        println!("[backend] restart attempt {attempt}/{BACKEND_START_RETRIES} on port {port}");

        if let Err(err) = spawn_backend_process(&app, port) {
            last_error = err;
            continue;
        }

        match wait_for_backend(port).await {
            Ok(()) => {
                app.emit("backend-restarted", "Backend restarted successfully.")
                    .ok();
                return Ok(());
            }
            Err(err) => {
                last_error = err;
                let state = app.state::<BackendState>();
                stop_backend(&state);
            }
        }
    }

    Err(format!("Restart failed: {last_error}"))
}

#[tauri::command]
async fn restart_backend_command(app: AppHandle) -> Result<(), String> {
    restart_backend(app).await
}

#[tauri::command]
fn open_logs_folder_command(app: AppHandle) -> Result<(), String> {
    let state = app.state::<BackendState>();
    open_path_in_file_manager(&state.logs_dir)
}

#[tauri::command]
fn open_data_folder_command(app: AppHandle) -> Result<(), String> {
    let state = app.state::<BackendState>();
    open_path_in_file_manager(&state.data_dir)
}

#[tauri::command]
async fn reset_local_db_command(app: AppHandle) -> Result<(), String> {
    let state = app.state::<BackendState>();
    let port = state
        .current_port
        .lock()
        .expect("backend port mutex poisoned")
        .to_owned()
        .ok_or_else(|| "Backend is not running".to_string())?;

    let client = reqwest::Client::new();
    let url = format!("{}{BACKEND_RESET_DB_PATH}", backend_base_url(port));
    let response = client
        .post(url)
        .send()
        .await
        .map_err(|err| format!("Failed to reset DB: {err}"))?;

    if !response.status().is_success() {
        return Err(format!("DB reset failed with status {}", response.status()));
    }

    app.emit("db-reset", "Local database reset").ok();
    Ok(())
}

fn show_startup_error_dialog(app: &AppHandle, message: &str) {
    app.dialog()
        .message(message.to_string())
        .title("Parlor startup failed")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

fn build_app_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let open_logs = MenuItem::with_id(app, "open_logs", "Open Logs", true, None::<&str>)?;
    let open_data = MenuItem::with_id(app, "open_data", "Open Data Folder", true, None::<&str>)?;
    let reset_db = MenuItem::with_id(app, "reset_db", "Reset Local DB", true, None::<&str>)?;

    let app_submenu =
        Submenu::with_items(app, "Parlor", true, &[&open_logs, &open_data, &reset_db])?;
    Menu::with_items(app, &[&app_submenu])
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            let backend_state = BackendState::new(&app_handle)?;
            app.manage(backend_state);

            let menu = build_app_menu(&app_handle)?;
            app.set_menu(menu)?;

            let menu_app = app_handle.clone();
            app.on_menu_event(move |app, event| match event.id().as_ref() {
                "open_logs" => {
                    if let Err(err) = open_logs_folder_command(app.clone()) {
                        menu_app.emit("menu-error", err).ok();
                    }
                }
                "open_data" => {
                    if let Err(err) = open_data_folder_command(app.clone()) {
                        menu_app.emit("menu-error", err).ok();
                    }
                }
                "reset_db" => {
                    let app_for_reset = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(err) = reset_local_db_command(app_for_reset).await {
                            eprintln!("[menu] reset db failed: {err}");
                        }
                    });
                }
                _ => {}
            });

            let startup_app = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = launch_backend_and_show_window(startup_app.clone()).await {
                    eprintln!("[startup] failed to launch backend: {err}");
                    show_startup_error_dialog(&startup_app, &err);
                    startup_app.emit("startup-failure", &err).ok();
                    tauri::async_runtime::sleep(Duration::from_millis(300)).await;
                    startup_app.exit(1);
                }
            });

            let restart_app = app_handle.clone();
            app_handle.listen("restart-backend-request", move |_event| {
                let restart_clone = restart_app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = restart_backend(restart_clone.clone()).await {
                        restart_clone.emit("backend-restart-failed", err).ok();
                    }
                });
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            restart_backend_command,
            open_logs_folder_command,
            open_data_folder_command,
            reset_local_db_command
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let WebviewWindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "windows")]
                {
                    api.prevent_close();
                    println!("[shutdown] Windows close requested; exiting app");
                    let app = window.app_handle();
                    let state = app.state::<BackendState>();
                    stop_backend(&state);
                    app.exit(0);
                }

                #[cfg(target_os = "macos")]
                {
                    api.prevent_close();
                    println!("[shutdown] macOS close requested; exiting app");
                    let app = window.app_handle();
                    let state = app.state::<BackendState>();
                    stop_backend(&state);
                    app.exit(0);
                }

                #[cfg(not(any(target_os = "windows", target_os = "macos")))]
                {
                    let app = window.app_handle();
                    let state = app.state::<BackendState>();
                    stop_backend(&state);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::ExitRequested { .. } => {
                let state = app_handle.state::<BackendState>();
                stop_backend(&state);
            }
            RunEvent::Exit => {
                let state = app_handle.state::<BackendState>();
                stop_backend(&state);
            }
            _ => {}
        });
}
