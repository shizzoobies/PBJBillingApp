// PB&J Accounting — desktop shell.
//
// A window around https://app.pbjsa.com, deliberately NOT a bundled copy of
// the frontend: the server deploys several times a week, and a shell pointed
// at prod is always exactly as current as the web app. See
// docs/plans/desktop-shell-2026-08.md in the repo root.
//
// Sign-in: the app emails a single-use magic link. In a browser that link
// signs the browser in — so when the sign-in request comes from this shell
// (spotted by the PBJDesktopShell user-agent marker), the email carries a
// second button pointing at pbjsa://verify/<token>. Windows routes that
// scheme here (registered by the installer), and we translate it back onto
// the app origin. Password sign-in works with no special handling.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

const APP_ORIGIN: &str = "https://app.pbjsa.com";

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

fn main() {
    tauri::Builder::default()
        // Must be first: a second launch (e.g. clicking a pbjsa:// link while
        // the shell is open) focuses the existing window and forwards the
        // link instead of opening a second copy.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let start: Url = format!("{APP_ORIGIN}/").parse().expect("static url");

            let opener_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(start))
                .title("PB&J Accounting")
                .inner_size(1280.0, 860.0)
                .min_inner_size(900.0, 600.0)
                // The marker the server's request-link handler looks for to
                // add the "Open in the desktop app" button to the email.
                .user_agent(concat!(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ",
                    "AppleWebKit/537.36 (KHTML, like Gecko) ",
                    "Chrome/126.0.0.0 Safari/537.36 PBJDesktopShell/0.1"
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

            let nav_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for link in event.urls() {
                    if let Some(dest) = deep_link_destination(&link) {
                        if let Some(window) = nav_handle.get_webview_window("main") {
                            let _ = window.navigate(dest);
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                }
            });

            // The installer registers pbjsa:// in the registry; this covers
            // running the built exe directly (or dev) without an install.
            let _ = app.deep_link().register_all();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the PB&J Accounting shell");
}
