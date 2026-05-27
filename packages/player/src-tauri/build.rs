fn main() {
    let attrs =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "extension_window_create",
            "extension_window_get",
            "extension_window_close",
            "extension_window_close_all",
            "extension_window_show",
            "extension_window_hide",
            "extension_window_focus",
            "extension_window_center",
            "extension_window_set_title",
            "extension_window_set_size",
            "extension_window_set_position",
            "extension_window_mark_ready",
            "extension_window_get_current",
            "extension_window_get_current_extension_files",
        ]));
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
