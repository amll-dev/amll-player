use serde::Deserialize;
use tauri::{
    AppHandle, Emitter, Manager, Runtime,
    menu::{
        HELP_SUBMENU_ID, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, WINDOW_SUBMENU_ID,
    },
};
use tracing::{info, warn};

/// Prefix of the menu item ids that are forwarded to the frontend.
const MENU_ID_PREFIX: &str = "amll.";

/// Emitted to the frontend when one of those items is clicked; the payload is the
/// menu item id, which has to match `MENU_ACTION_IDS` on the frontend side.
const MENU_ACTION_EVENT: &str = "app-menu:action";

/// Labels of the macOS application menu; missing fields fall back to English.
///
/// `{appName}` inside a label is replaced with the application name.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MenuLabels {
    pub about: Option<String>,
    pub settings: Option<String>,
    pub services: Option<String>,
    pub hide: Option<String>,
    pub hide_others: Option<String>,
    pub quit: Option<String>,
    pub file: Option<String>,
    pub close_window: Option<String>,
    pub edit: Option<String>,
    pub undo: Option<String>,
    pub redo: Option<String>,
    pub cut: Option<String>,
    pub copy: Option<String>,
    pub paste: Option<String>,
    pub select_all: Option<String>,
    pub view: Option<String>,
    pub fullscreen: Option<String>,
    pub window: Option<String>,
    pub minimize: Option<String>,
    pub zoom: Option<String>,
    pub help: Option<String>,
    pub show_all: Option<String>,
    pub check_update: Option<String>,
    pub playback: Option<String>,
    pub play_pause: Option<String>,
    pub prev_song: Option<String>,
    pub next_song: Option<String>,
    pub cycle_repeat: Option<String>,
    pub toggle_shuffle: Option<String>,
    pub github_repo: Option<String>,
    pub report_issue: Option<String>,
}

/// Builds the macOS application menu.
///
/// The structure mirrors Tauri's `Menu::default()` (App / File / Edit / View / Window /
/// Help), but every item that needs to reach the app is a plain menu item that emits
/// `MENU_ACTION_EVENT` instead of running a native selector. About has to be one of them:
/// muda's predefined About calls `orderFrontStandardAboutPanel` and never reports a menu
/// event, so it cannot be intercepted. All other items stay predefined to keep the native
/// accelerators and behaviour.
///
/// Labels are synced from the frontend (see `update_app_menu`) and fall back to English
/// until the first sync.
pub fn create_menu<R: Runtime>(app: &AppHandle<R>, labels: &MenuLabels) -> tauri::Result<Menu<R>> {
    let app_name = app.package_info().name.clone();
    let label = |template: &Option<String>, fallback: &str| {
        template
            .as_deref()
            .unwrap_or(fallback)
            .replace("{appName}", &app_name)
    };

    let about = MenuItem::with_id(
        app,
        "amll.about",
        label(&labels.about, "About {appName}"),
        true,
        None::<&str>,
    )?;

    let settings = MenuItem::with_id(
        app,
        "amll.settings",
        label(&labels.settings, "Settings…"),
        true,
        Some("Cmd+,"),
    )?;

    let check_update = MenuItem::with_id(
        app,
        "amll.check-update",
        label(&labels.check_update, "Check for Updates…"),
        true,
        None::<&str>,
    )?;

    let app_submenu = Submenu::with_items(
        app,
        &app_name,
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &check_update,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(&label(&labels.services, "Services")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&label(&labels.hide, "Hide {appName}")))?,
            &PredefinedMenuItem::hide_others(
                app,
                Some(&label(&labels.hide_others, "Hide Others")),
            )?,
            &PredefinedMenuItem::show_all(app, Some(&label(&labels.show_all, "Show All")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&label(&labels.quit, "Quit {appName}")))?,
        ],
    )?;

    let file_submenu = Submenu::with_items(
        app,
        label(&labels.file, "File"),
        true,
        &[&PredefinedMenuItem::close_window(
            app,
            Some(&label(&labels.close_window, "Close Window")),
        )?],
    )?;

    let edit_submenu = Submenu::with_items(
        app,
        label(&labels.edit, "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&label(&labels.undo, "Undo")))?,
            &PredefinedMenuItem::redo(app, Some(&label(&labels.redo, "Redo")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(&label(&labels.cut, "Cut")))?,
            &PredefinedMenuItem::copy(app, Some(&label(&labels.copy, "Copy")))?,
            &PredefinedMenuItem::paste(app, Some(&label(&labels.paste, "Paste")))?,
            &PredefinedMenuItem::select_all(app, Some(&label(&labels.select_all, "Select All")))?,
        ],
    )?;

    let view_submenu = Submenu::with_items(
        app,
        label(&labels.view, "View"),
        true,
        &[&PredefinedMenuItem::fullscreen(
            app,
            Some(&label(&labels.fullscreen, "Toggle Full Screen")),
        )?],
    )?;

    // Playback actions are dispatched to the frontend, so no accelerators here on purpose:
    // ShotcutContext already registers system-wide global shortcuts (⌥⌘P / ⌥⌘← / ⌥⌘→)
    // and AppKit key equivalents would fight over the same keys.
    let playback_submenu = Submenu::with_items(
        app,
        label(&labels.playback, "Playback"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "amll.play-pause",
                label(&labels.play_pause, "Play/Pause"),
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                "amll.prev-song",
                label(&labels.prev_song, "Previous Song"),
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                "amll.next-song",
                label(&labels.next_song, "Next Song"),
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "amll.cycle-repeat",
                label(&labels.cycle_repeat, "Repeat"),
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                "amll.toggle-shuffle",
                label(&labels.toggle_shuffle, "Shuffle"),
                true,
                None::<&str>,
            )?,
        ],
    )?;

    // These two submenus have to keep Tauri's reserved ids, otherwise `init_app_menu` does
    // not hand them to AppKit and the window list / Help search field disappear.
    let window_submenu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        label(&labels.window, "Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&label(&labels.minimize, "Minimize")))?,
            &PredefinedMenuItem::maximize(app, Some(&label(&labels.zoom, "Zoom")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(
                app,
                Some(&label(&labels.close_window, "Close Window")),
            )?,
            &PredefinedMenuItem::bring_all_to_front(app, None::<&str>)?,
        ],
    )?;

    // On macOS the Help menu starts out empty and the system adds the search field,
    // so it is used for the project links.
    let help_submenu = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        label(&labels.help, "Help"),
        true,
        &[
            &MenuItem::with_id(
                app,
                "amll.github-repo",
                label(&labels.github_repo, "GitHub Repository"),
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                "amll.report-issue",
                label(&labels.report_issue, "Report an Issue"),
                true,
                None::<&str>,
            )?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &playback_submenu,
            &window_submenu,
            &help_submenu,
        ],
    )
}

/// Handles menu clicks and forwards the custom items to the frontend.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if !id.starts_with(MENU_ID_PREFIX) {
        return;
    }

    // The menu can be clicked while the main window is hidden or minimised, so bring it
    // back to the front first.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }

    if let Err(err) = app.emit_to("main", MENU_ACTION_EVENT, id) {
        warn!("转发应用菜单事件失败: {err}");
    }
}

/// Rebuilds the application menu with the labels supplied by the frontend, called whenever
/// the application language changes.
#[tauri::command]
pub fn update_app_menu(app: AppHandle, labels: MenuLabels) -> Result<(), String> {
    info!("Rebuilt application menu for the current language");
    let menu = create_menu(&app, &labels).map_err(|err| err.to_string())?;
    app.set_menu(menu).map_err(|err| err.to_string())?;
    Ok(())
}
