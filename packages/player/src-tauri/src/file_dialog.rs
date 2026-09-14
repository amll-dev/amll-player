use serde::Deserialize;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, Window};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_fs::FsExt;

const FILE_DIALOG_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDialogFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FileDialogOptions {
    title: Option<String>,
    filters: Vec<FileDialogFilter>,
    directory: bool,
    multiple: bool,
    recursive: bool,
}

/// Opens an ownerless Windows Shell picker through the plugin's callback API.
///
/// The JavaScript `open` command automatically parents `IFileDialog` to our
/// transparent frameless main window and then enters a blocking picker path.
/// That combination has repeatedly hung both Explorer and the application on
/// Windows. Keeping the picker ownerless and awaiting a callback avoids both
/// parts of that failure mode.
#[tauri::command]
pub async fn pick_files_ownerless<R: Runtime>(
    app: AppHandle<R>,
    window: Window<R>,
    options: FileDialogOptions,
) -> Result<Option<Vec<String>>, String> {
    let is_directory = options.directory;
    let is_multiple = options.multiple;
    let is_recursive = options.recursive;
    let mut dialog = app.dialog().file();
    if let Some(title) = options.title.filter(|title| !title.is_empty()) {
        dialog = dialog.set_title(title);
    }
    for filter in options.filters {
        let extensions = filter
            .extensions
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        dialog = dialog.add_filter(filter.name, &extensions);
    }

    // Keep the ownerless dialog modal from the application's point of view.
    // This prevents navigation or route state from changing while a pending
    // selection still belongs to the page that opened it.
    window
        .set_enabled(false)
        .map_err(|error| error.to_string())?;

    let (sender, receiver) = tokio::sync::oneshot::channel::<Option<Vec<FilePath>>>();
    if is_directory {
        if is_multiple {
            dialog.pick_folders(move |selected| {
                let _ = sender.send(selected);
            });
        } else {
            dialog.pick_folder(move |selected| {
                let _ = sender.send(selected.map(|path| vec![path]));
            });
        }
    } else if is_multiple {
        dialog.pick_files(move |selected| {
            let _ = sender.send(selected);
        });
    } else {
        dialog.pick_file(move |selected| {
            let _ = sender.send(selected.map(|path| vec![path]));
        });
    }

    let selected_result = tokio::time::timeout(FILE_DIALOG_TIMEOUT, receiver)
        .await
        .map_err(|_| "The file picker timed out.".to_string())
        .and_then(|result| {
            result.map_err(|_| "The file picker was closed before returning a result.".to_string())
        });

    let reenable_result = window.set_enabled(true).map_err(|error| error.to_string());
    let _ = window.set_focus();
    let selected_result = selected_result?;
    reenable_result?;

    if let Some(paths) = &selected_result {
        let tauri_scope = window.state::<tauri::scope::Scopes>();
        for file_path in paths {
            let Ok(path) = file_path.clone().into_path() else {
                continue;
            };
            if is_directory {
                if let Some(fs_scope) = window.try_fs_scope() {
                    fs_scope
                        .allow_directory(&path, is_recursive)
                        .map_err(|error| error.to_string())?;
                }
                tauri_scope
                    .allow_directory(&path, true)
                    .map_err(|error| error.to_string())?;
            } else {
                if let Some(fs_scope) = window.try_fs_scope() {
                    fs_scope
                        .allow_file(&path)
                        .map_err(|error| error.to_string())?;
                }
                tauri_scope
                    .allow_file(&path)
                    .map_err(|error| error.to_string())?;
            }
        }
    }

    Ok(selected_result.map(|paths| {
        paths
            .into_iter()
            .map(|path| path.simplified().to_string())
            .collect()
    }))
}
