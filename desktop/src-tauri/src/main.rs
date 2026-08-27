// PB&J Accounting — desktop shell.
//
// A window around https://app.pbjsa.com, deliberately NOT a bundled copy of
// the frontend: the server deploys several times a week, and a shell pointed
// at prod is always exactly as current as the web app. See
// docs/plans/desktop-shell-2026-08.md in the repo root.
//
// Sign-in: the topbar's "Open in desktop" button in the WEB app mints a
// one-time token and opens pbjsa://verify/<token>, which Windows routes here
// (registered by the installer). We translate it back onto the app origin.
// Password sign-in inside the shell needs no special handling. (An email
// pbjsa:// button was tried first and is dead on arrival — web mail clients
// strip app-opening link schemes.)
//
// Phase 3 (Alex's decisions, 2026-08-27): close button hides to the system
// tray; auto-start on login is ON by default (toggleable from the tray, and
// the user's later choice is never overridden — see the first-run marker);
// the shell updates ITSELF via signed GitHub Releases. App content needs no
// updates at all — the site is live.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

const APP_ORIGIN: &str = "https://app.pbjsa.com";
/// Re-check for shell updates this often while running (launch also checks).
const UPDATE_CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

/// pbjsa://verify/<token> → https://app.pbjsa.com/verify/<token>.
///
/// Security property: the destination is BUILT onto our origin from the
/// link's host+path — a hostile pbjsa:// link can steer the window only to
/// pages on app.pbjsa.com, never to an attacker's site.
fn deep_link_destination(link: &Url) -> Option<Url> {
    if link.scheme() != "pbjsa" {
        return None;
    }
    let host = link.host_str().unwrap_or("");
    let dest = format!("{APP_ORIGIN}/{host}{}", link.path());
    dest.parse().ok()
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Check GitHub Releases for a newer shell, download, and offer a restart.
/// Quiet when current unless `announce_up_to_date` (the tray's manual check).
fn check_for_shell_update(app: tauri::AppHandle, announce_up_to_date: bool) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(error) => {
                eprintln!("[updater] unavailable: {error}");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        let restart_now = app
                            .dialog()
                            .message(format!(
                                "Shell update {version} is installed and will apply on the next \
                                 launch. Restart now? (The app itself is always current — this \
                                 only updates the window around it.)"
                            ))
                            .title("PB&J Accounting")
                            .kind(MessageDialogKind::Info)
                            .buttons(MessageDialogButtons::OkCancelCustom(
                                "Restart now".into(),
                                "Later".into(),
                            ))
                            .blocking_show();
                        if restart_now {
                            app.restart();
                        }
                    }
                    Err(error) => eprintln!("[updater] install failed: {error}"),
                }
            }
            Ok(None) => {
                if announce_up_to_date {
                    app.dialog()
                        .message("The shell is up to date.")
                        .title("PB&J Accounting")
                        .kind(MessageDialogKind::Info)
                        .blocking_show();
                }
            }
            Err(error) => eprintln!("[updater] check failed: {error}"),
        }
    });
}

/// Auto-start defaults ON (Alex's call) — but only ever forced on the FIRST
/// run. A marker file records that the default was applied; after that the
/// tray toggle is the user's, and we never fight it on later launches.
fn apply_autostart_default(app: &tauri::AppHandle) {
    let Ok(config_dir) = app.path().app_config_dir() else {
        return;
    };
    let marker = config_dir.join("autostart-default-applied");
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&config_dir);
    if app.autolaunch().enable().is_ok() {
        let _ = std::fs::write(&marker, b"applied\n");
    }
}

fn main() {
    tauri::Builder::default()
        // Must be first: a second launch (e.g. clicking a pbjsa:// link while
        // the shell is open) focuses the existing window and forwards the
        // link instead of opening a second copy.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let start: Url = format!("{APP_ORIGIN}/").parse().expect("static url");

            let opener_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(start))
                .title("PB&J Accounting")
                .inner_size(1280.0, 860.0)
                .min_inner_size(900.0, 600.0)
                // The marker the server's handoff + any UA-gated behavior
                // looks for, and what hides the web app's own "Open in
                // desktop" button inside the shell.
                .user_agent(concat!(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ",
                    "AppleWebKit/537.36 (KHTML, like Gecko) ",
                    "Chrome/126.0.0.0 Safari/537.36 PBJDesktopShell/0.2"
                ))
                // The shell shows the app and nothing else. Any navigation
                // off the app origin opens in the person's real browser.
                .on_navigation(move |url| {
                    let target = url.as_str();
                    if target.starts_with(APP_ORIGIN)
                        || matches!(url.scheme(), "about" | "data" | "blob")
                    {
                        return true;
                    }
                    let _ = opener_handle.opener().open_url(target, None::<&str>);
                    false
                })
                .build()?;

            // ---- deep links (sign-in handoff) ----
            let nav_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for link in event.urls() {
                    if let Some(dest) = deep_link_destination(&link) {
                        if let Some(window) = nav_handle.get_webview_window("main") {
                            let _ = window.navigate(dest);
                        }
                        show_main_window(&nav_handle);
                    }
                }
            });
            // The installer registers pbjsa:// in the registry; this covers
            // running the built exe directly (or dev) without an install.
            let _ = app.deep_link().register_all();

            // ---- auto-start (default ON, first run only) ----
            apply_autostart_default(app.handle());

            // ---- tray ----
            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let open_item = MenuItem::with_id(app, "open", "Open PB&J Accounting", true, None::<&str>)?;
            let autostart_item = CheckMenuItem::with_id(
                app,
                "autostart",
                "Start with Windows",
                true,
                autostart_on,
                None::<&str>,
            )?;
            let update_item =
                MenuItem::with_id(app, "check-update", "Check for shell updates", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &autostart_item, &update_item, &quit_item])?;

            let autostart_item_for_menu = autostart_item.clone();
            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .tooltip("PB&J Accounting")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "autostart" => {
                        let manager = app.autolaunch();
                        let now_on = manager.is_enabled().unwrap_or(false);
                        let result = if now_on { manager.disable() } else { manager.enable() };
                        if result.is_ok() {
                            let _ = autostart_item_for_menu.set_checked(!now_on);
                        }
                    }
                    "check-update" => check_for_shell_update(app.clone(), true),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // ---- shell self-update: on launch, then every few hours ----
            check_for_shell_update(app.handle().clone(), false);
            let interval_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(UPDATE_CHECK_EVERY);
                check_for_shell_update(interval_handle.clone(), false);
            });

            Ok(())
        })
        // Close-to-tray: the X hides the window; the tray's Quit exits.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the PB&J Accounting shell");
}
