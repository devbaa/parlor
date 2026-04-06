use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

const BACKEND_HEALTH_PATH: &str = "/api/health";
const BACKEND_SIDECAR_NAME: &str = "parlor-backend";
const BACKEND_MAX_WAIT_SECS: u64 = 60;

#[derive(Default)]
struct BackendState {
    child: Mutex<Option<CommandChild>>,
    started: AtomicBool,
    stopping: AtomicBool,
}

fn allocate_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|err| format!("port bind failed: {err}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| format!("port read failed: {err}"))
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
}

async fn wait_for_backend(port: u16) -> Result<(), String> {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:{port}{BACKEND_HEALTH_PATH}");

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

async fn launch_backend_and_show_window(app: AppHandle) -> Result<(), String> {
    let state = app.state::<BackendState>();

    if state.started.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let port = allocate_port()?;
    println!("[backend] selected dynamic port {port}");

    let mut command = tauri_plugin_shell::process::Command::new_sidecar(BACKEND_SIDECAR_NAME)
        .map_err(|err| format!("sidecar init failed: {err}"))?;

    command = command.env("PORT", port.to_string());

    let (mut rx, child) = command
        .spawn()
        .map_err(|err| format!("backend spawn failed: {err}"))?;

    {
        let mut guard = state.child.lock().expect("backend child mutex poisoned");
        *guard = Some(child);
    }

    println!("[backend] backend process started");

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    if let Ok(line) = String::from_utf8(bytes) {
                        print!("[backend][stdout] {line}");
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    if let Ok(line) = String::from_utf8(bytes) {
                        eprint!("[backend][stderr] {line}");
                    }
                }
                CommandEvent::Error(error) => {
                    eprintln!("[backend][event-error] {error}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[backend] terminated: {payload:?}");
                }
                _ => {}
            }
        }
    });

    wait_for_backend(port).await?;

    let main_window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let url = format!("http://127.0.0.1:{port}");
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
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BackendState::default())
        .setup(|app| {
            let app_handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                if let Err(err) = launch_backend_and_show_window(app_handle.clone()).await {
                    eprintln!("[startup] failed to launch backend: {err}");
                    app_handle.emit("startup-failure", &err).ok();
                    app_handle.exit(1);
                }
            });

            Ok(())
        })
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
