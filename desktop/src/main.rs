// Chatboard desktop: a native window around the local Chatboard server.
//
// - starts `node server.js` if nothing is listening yet (and stops it on Quit)
// - closing the window hides it to the tray, so contacts can still text you
//   first and reminders still arrive
// - `--hidden` starts straight to the tray (used for autostart)
// - launching it again just brings the existing window back

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::OpenOptions,
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

/// The server process, if this app started it.
struct Server(Mutex<Option<Child>>);

fn port() -> u16 {
    std::env::var("CHATBOARD_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3210)
}

fn server_up(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

/// Runtime env var, else the value baked in at build time by install-desktop.
fn setting(name: &str, baked: Option<&'static str>) -> Option<String> {
    std::env::var(name).ok().or_else(|| baked.map(String::from))
}

fn chatboard_dir() -> PathBuf {
    if let Some(dir) = setting("CHATBOARD_DIR", option_env!("CHATBOARD_DIR")) {
        return PathBuf::from(dir);
    }
    // fall back to walking up from the executable (e.g. desktop/target/release)
    let exe = std::env::current_exe().unwrap_or_default();
    exe.ancestors()
        .find(|p| p.join("server.js").is_file())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn log_path() -> PathBuf {
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("chatboard.log")
}

fn spawn_server(port: u16) -> std::io::Result<Child> {
    let dir = chatboard_dir();
    let node = setting("CHATBOARD_NODE", option_env!("CHATBOARD_NODE")).unwrap_or_else(|| "node".into());
    let log_file = log_path();
    if let Some(parent) = log_file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log = OpenOptions::new().create(true).append(true).open(&log_file)?;
    Command::new(node)
        .arg(dir.join("server.js"))
        .current_dir(&dir)
        .env("PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn show_error(app: &AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let log = log_path().display().to_string();
        let js = format!(
            "document.getElementById('status').textContent = {msg:?};\
             const e = document.getElementById('error'); e.style.display = 'block';\
             e.innerHTML = 'Check the log: <code>' + {log:?} + '</code>';",
            msg = message,
            log = log
        );
        let _ = window.eval(&js);
        let _ = window.show();
    }
}

fn main() {
    tauri::Builder::default()
        // must be first: a second launch just focuses the running one
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Server(Mutex::new(None)))
        .setup(|app| {
            let hidden = std::env::args().any(|a| a == "--hidden");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Chatboard")
                .inner_size(1200.0, 800.0)
                .min_inner_size(380.0, 520.0)
                .visible(!hidden)
                .build()?;

            // tray: Linux tray icons only reliably support a menu, not clicks
            let open = MenuItem::with_id(app, "open", "Open Chatboard", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Chatboard", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &sep, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Chatboard")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // start the server if needed, then swap the splash for the app
            let port = port();
            let handle = app.handle().clone();
            if !server_up(port) {
                match spawn_server(port) {
                    Ok(child) => *app.state::<Server>().0.lock().unwrap() = Some(child),
                    Err(err) => {
                        show_error(&handle, &format!("Couldn't start the Chatboard server: {err}"));
                        return Ok(());
                    }
                }
            }
            thread::spawn(move || {
                let started = Instant::now();
                while !server_up(port) {
                    if started.elapsed() > Duration::from_secs(25) {
                        show_error(&handle, "The Chatboard server didn't start.");
                        return;
                    }
                    thread::sleep(Duration::from_millis(150));
                }
                if let (Some(window), Ok(url)) = (
                    handle.get_webview_window("main"),
                    format!("http://127.0.0.1:{port}/").parse(),
                ) {
                    let _ = window.navigate(url);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // closing hides to the tray; "Quit" in the tray menu really exits
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start Chatboard")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Server>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
