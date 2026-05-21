use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, LogicalUnit, Manager, PixelUnit, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowSizeConstraints, path::BaseDirectory,
};

const EXTENSION_WINDOW_LABEL_PREFIX: &str = "extension-window/";
const EXTENSION_WINDOW_ENTRY: &str = "extension-window.html";
const DEFAULT_WINDOW_WIDTH: f64 = 800.0;
const DEFAULT_WINDOW_HEIGHT: f64 = 600.0;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionWindowInfo {
    pub extension_id: String,
    pub window_id: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionScriptFile {
    pub file_name: String,
    pub script_data: String,
}

struct ExtensionScriptSource {
    file_name: String,
    script_data: String,
    id: Option<String>,
    dependency: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionWindowOptions {
    pub title: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub center: Option<bool>,
    pub resizable: Option<bool>,
    pub decorations: Option<bool>,
    pub visible: Option<bool>,
    pub min_width: Option<f64>,
    pub min_height: Option<f64>,
    pub max_width: Option<f64>,
    pub max_height: Option<f64>,
}

#[derive(Default)]
pub struct ExtensionWindowState {
    windows: Mutex<ExtensionWindowMaps>,
}

#[derive(Default)]
struct ExtensionWindowMaps {
    by_label: HashMap<String, ExtensionWindowInfo>,
    by_extension: HashMap<String, HashSet<String>>,
}

impl ExtensionWindowState {
    fn insert(&self, info: ExtensionWindowInfo) {
        let mut maps = self.windows.lock().unwrap();
        maps.by_extension
            .entry(info.extension_id.clone())
            .or_default()
            .insert(info.label.clone());
        maps.by_label.insert(info.label.clone(), info);
    }

    fn get_by_label(&self, label: &str) -> Option<ExtensionWindowInfo> {
        self.windows.lock().unwrap().by_label.get(label).cloned()
    }

    fn get_by_owner(
        &self,
        extension_id: &str,
        window_id: &str,
    ) -> Result<Option<ExtensionWindowInfo>, String> {
        let label = make_extension_window_label(extension_id, window_id)?;
        Ok(self.get_by_label(&label))
    }

    fn labels_for_extension(&self, extension_id: &str) -> Vec<String> {
        self.windows
            .lock()
            .unwrap()
            .by_extension
            .get(extension_id)
            .map(|labels| labels.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn all_labels(&self) -> Vec<String> {
        self.windows
            .lock()
            .unwrap()
            .by_label
            .keys()
            .cloned()
            .collect()
    }

    fn remove_label(&self, label: &str) -> Option<ExtensionWindowInfo> {
        let mut maps = self.windows.lock().unwrap();
        let info = maps.by_label.remove(label)?;
        let should_remove_extension =
            if let Some(labels) = maps.by_extension.get_mut(&info.extension_id) {
                labels.remove(label);
                labels.is_empty()
            } else {
                false
            };
        if should_remove_extension {
            maps.by_extension.remove(&info.extension_id);
        }
        Some(info)
    }
}

fn validate_extension_id(extension_id: &str) -> Result<(), String> {
    if extension_id.trim().is_empty() {
        Err("extensionId must not be empty".to_string())
    } else {
        Ok(())
    }
}

fn validate_window_id(window_id: &str) -> Result<(), String> {
    let len = window_id.len();
    if !(1..=64).contains(&len) {
        return Err("windowId length must be between 1 and 64".to_string());
    }
    if !window_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("windowId may only contain ASCII letters, digits, '_' and '-'".to_string());
    }
    Ok(())
}

fn validate_positive_number(value: f64, name: &str) -> Result<f64, String> {
    if value.is_finite() && value > 0.0 {
        Ok(value)
    } else {
        Err(format!("{name} must be a positive finite number"))
    }
}

fn validate_finite_number(value: f64, name: &str) -> Result<f64, String> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("{name} must be a finite number"))
    }
}

fn parse_extension_script_source(file_name: String, script_data: String) -> ExtensionScriptSource {
    let mut source = ExtensionScriptSource {
        file_name,
        script_data,
        id: None,
        dependency: Vec::new(),
    };

    for line in source.script_data.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Some(comment) = trimmed.strip_prefix("//") else {
            break;
        };
        let Some(meta_line) = comment.trim_start().strip_prefix('@') else {
            break;
        };
        let mut parts = meta_line.splitn(2, char::is_whitespace);
        let key = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default().trim();
        if key.is_empty() || value.is_empty() {
            break;
        }

        match key {
            "id" if source.id.is_none() => source.id = Some(value.to_string()),
            "dependency" => source.dependency.push(value.to_string()),
            _ => {}
        }
    }

    source
}

fn collect_extension_file_indices(
    extension_id: &str,
    sources: &[ExtensionScriptSource],
    sources_by_id: &HashMap<String, Vec<usize>>,
    visiting: &mut HashSet<String>,
    collected_indices: &mut HashSet<usize>,
) -> Result<(), String> {
    if !visiting.insert(extension_id.to_string()) {
        return Err(format!("circular extension dependency: {extension_id}"));
    }

    if let Some(indices) = sources_by_id.get(extension_id) {
        for index in indices {
            if let Some(source) = sources.get(*index) {
                for dependency_id in &source.dependency {
                    collect_extension_file_indices(
                        dependency_id,
                        sources,
                        sources_by_id,
                        visiting,
                        collected_indices,
                    )?;
                }
                collected_indices.insert(*index);
            }
        }
    }

    visiting.remove(extension_id);
    Ok(())
}

fn extension_id_hash(extension_id: &str) -> String {
    format!("{:x}", md5::compute(extension_id.as_bytes()))
}

fn make_extension_window_label(extension_id: &str, window_id: &str) -> Result<String, String> {
    validate_extension_id(extension_id)?;
    validate_window_id(window_id)?;
    Ok(format!(
        "{EXTENSION_WINDOW_LABEL_PREFIX}{}/{window_id}",
        extension_id_hash(extension_id)
    ))
}

fn is_extension_window_label(label: &str) -> bool {
    label.starts_with(EXTENSION_WINDOW_LABEL_PREFIX)
}

fn parse_extension_window_label(label: &str) -> Option<(&str, &str)> {
    let rest = label.strip_prefix(EXTENSION_WINDOW_LABEL_PREFIX)?;
    let (extension_hash, window_id) = rest.split_once('/')?;
    if extension_hash.is_empty() || window_id.is_empty() {
        None
    } else {
        Some((extension_hash, window_id))
    }
}

fn ensure_command_owner(
    caller: &WebviewWindow,
    extension_id: &str,
    state: &ExtensionWindowState,
) -> Result<(), String> {
    if caller.label() == "main" {
        return Ok(());
    }

    let caller_label = caller.label();
    if !is_extension_window_label(caller_label) {
        return Err(
            "extension window commands can only be called from main or extension windows"
                .to_string(),
        );
    }

    if let Some(info) = state.get_by_label(caller_label) {
        if info.extension_id == extension_id {
            return Ok(());
        }
        return Err("caller does not own this extension window".to_string());
    }

    let Some((extension_hash, _)) = parse_extension_window_label(caller_label) else {
        return Err("invalid extension window label".to_string());
    };

    if extension_hash == extension_id_hash(extension_id) {
        Ok(())
    } else {
        Err("caller does not own this extension window".to_string())
    }
}

fn extension_window_url(app: &AppHandle) -> Result<WebviewUrl, String> {
    #[cfg(debug_assertions)]
    {
        let dev_url = app
            .config()
            .build
            .dev_url
            .clone()
            .ok_or_else(|| "devUrl is not configured".to_string())?;
        dev_url
            .join(EXTENSION_WINDOW_ENTRY)
            .map(WebviewUrl::External)
            .map_err(|err| format!("failed to create extension window URL: {err}"))
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        Ok(WebviewUrl::App(EXTENSION_WINDOW_ENTRY.into()))
    }
}

fn logical_pixel_unit(value: f64) -> PixelUnit {
    PixelUnit::Logical(LogicalUnit::new(value))
}

fn resolve_size_constraints(
    options: &ExtensionWindowOptions,
) -> Result<WindowSizeConstraints, String> {
    if let (Some(min_width), Some(max_width)) = (options.min_width, options.max_width) {
        if validate_positive_number(min_width, "minWidth")?
            > validate_positive_number(max_width, "maxWidth")?
        {
            return Err("minWidth must be less than or equal to maxWidth".to_string());
        }
    }
    if let (Some(min_height), Some(max_height)) = (options.min_height, options.max_height) {
        if validate_positive_number(min_height, "minHeight")?
            > validate_positive_number(max_height, "maxHeight")?
        {
            return Err("minHeight must be less than or equal to maxHeight".to_string());
        }
    }

    Ok(WindowSizeConstraints {
        min_width: options
            .min_width
            .map(|value| validate_positive_number(value, "minWidth").map(logical_pixel_unit))
            .transpose()?,
        min_height: options
            .min_height
            .map(|value| validate_positive_number(value, "minHeight").map(logical_pixel_unit))
            .transpose()?,
        max_width: options
            .max_width
            .map(|value| validate_positive_number(value, "maxWidth").map(logical_pixel_unit))
            .transpose()?,
        max_height: options
            .max_height
            .map(|value| validate_positive_number(value, "maxHeight").map(logical_pixel_unit))
            .transpose()?,
    })
}

fn has_size_constraints(options: &ExtensionWindowOptions) -> bool {
    options.min_width.is_some()
        || options.min_height.is_some()
        || options.max_width.is_some()
        || options.max_height.is_some()
}

fn get_window_for_owner(
    app: &AppHandle,
    state: &ExtensionWindowState,
    extension_id: &str,
    window_id: &str,
) -> Result<Option<(ExtensionWindowInfo, WebviewWindow)>, String> {
    let label = make_extension_window_label(extension_id, window_id)?;
    if let Some(win) = app.get_webview_window(&label) {
        let info = state
            .get_by_label(&label)
            .unwrap_or_else(|| ExtensionWindowInfo {
                extension_id: extension_id.to_string(),
                window_id: window_id.to_string(),
                label,
            });
        state.insert(info.clone());
        Ok(Some((info, win)))
    } else {
        state.remove_label(&label);
        Ok(None)
    }
}

#[tauri::command]
pub async fn extension_window_create(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
    extension_id: String,
    window_id: String,
    options: Option<ExtensionWindowOptions>,
) -> Result<ExtensionWindowInfo, String> {
    ensure_command_owner(&caller, &extension_id, &state)?;

    let label = make_extension_window_label(&extension_id, &window_id)?;
    if let Some(info) = state.get_by_owner(&extension_id, &window_id)? {
        if let Some(win) = app.get_webview_window(&info.label) {
            let _ = win.show();
            let _ = win.set_focus();
            return Ok(info);
        }
        state.remove_label(&info.label);
    } else if let Some(win) = app.get_webview_window(&label) {
        let info = ExtensionWindowInfo {
            extension_id,
            window_id,
            label,
        };
        state.insert(info.clone());
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(info);
    }

    let options = options.unwrap_or_default();
    let width = validate_positive_number(options.width.unwrap_or(DEFAULT_WINDOW_WIDTH), "width")?;
    let height =
        validate_positive_number(options.height.unwrap_or(DEFAULT_WINDOW_HEIGHT), "height")?;
    let visible = options.visible.unwrap_or(true);
    let title = options
        .title
        .clone()
        .unwrap_or_else(|| "AMLL Player Extension".to_string());
    let should_center = options
        .center
        .unwrap_or(options.x.is_none() && options.y.is_none());

    let mut builder = WebviewWindowBuilder::new(&app, &label, extension_window_url(&app)?)
        .title(title)
        .inner_size(width, height)
        .resizable(options.resizable.unwrap_or(true))
        .decorations(options.decorations.unwrap_or(true))
        .visible(visible);

    if has_size_constraints(&options) {
        builder = builder.inner_size_constraints(resolve_size_constraints(&options)?);
    }

    if should_center {
        builder = builder.center();
    } else if options.x.is_some() || options.y.is_some() {
        let x = validate_finite_number(
            options
                .x
                .ok_or_else(|| "x and y must be provided together".to_string())?,
            "x",
        )?;
        let y = validate_finite_number(
            options
                .y
                .ok_or_else(|| "x and y must be provided together".to_string())?,
            "y",
        )?;
        builder = builder.position(x, y);
    }

    let win = builder
        .build()
        .map_err(|err| format!("failed to create extension window: {err}"))?;

    if visible {
        let _ = win.set_focus();
    }

    let info = ExtensionWindowInfo {
        extension_id,
        window_id,
        label,
    };
    state.insert(info.clone());
    Ok(info)
}

#[tauri::command]
pub fn extension_window_get(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
    extension_id: String,
    window_id: String,
) -> Result<Option<ExtensionWindowInfo>, String> {
    ensure_command_owner(&caller, &extension_id, &state)?;
    Ok(get_window_for_owner(&app, &state, &extension_id, &window_id)?.map(|(info, _)| info))
}

#[tauri::command]
pub fn extension_window_close(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
    extension_id: String,
    window_id: String,
) -> Result<(), String> {
    ensure_command_owner(&caller, &extension_id, &state)?;
    if let Some((_, win)) = get_window_for_owner(&app, &state, &extension_id, &window_id)? {
        win.close()
            .map_err(|err| format!("failed to close extension window: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn extension_window_close_all(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
    extension_id: String,
) -> Result<(), String> {
    ensure_command_owner(&caller, &extension_id, &state)?;
    for label in state.labels_for_extension(&extension_id) {
        if let Some(win) = app.get_webview_window(&label) {
            win.close()
                .map_err(|err| format!("failed to close extension window: {err}"))?;
        } else {
            state.remove_label(&label);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn extension_window_show(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
    extension_id: String,
    window_id: String,
) -> Result<(), String> {
    ensure_command_owner(&caller, &extension_id, &state)?;
    if let Some((_, win)) = get_window_for_owner(&app, &state, &extension_id, &window_id)? {
        win.show()
            .map_err(|err| format!("failed to show extension window: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn extension_window_hide(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
    extension_id: String,
    window_id: String,
) -> Result<(), String> {
    ensure_command_owner(&caller, &extension_id, &state)?;
    if let Some((_, win)) = get_window_for_owner(&app, &state, &extension_id, &window_id)? {
        win.hide()
            .map_err(|err| format!("failed to hide extension window: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn extension_window_focus(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
    extension_id: String,
    window_id: String,
) -> Result<(), String> {
    ensure_command_owner(&caller, &extension_id, &state)?;
    if let Some((_, win)) = get_window_for_owner(&app, &state, &extension_id, &window_id)? {
        win.set_focus()
            .map_err(|err| format!("failed to focus extension window: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn extension_window_center(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
    extension_id: String,
    window_id: String,
) -> Result<(), String> {
    ensure_command_owner(&caller, &extension_id, &state)?;
    if let Some((_, win)) = get_window_for_owner(&app, &state, &extension_id, &window_id)? {
        win.center()
            .map_err(|err| format!("failed to center extension window: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn extension_window_set_title(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
    extension_id: String,
    window_id: String,
    title: String,
) -> Result<(), String> {
    ensure_command_owner(&caller, &extension_id, &state)?;
    if let Some((_, win)) = get_window_for_owner(&app, &state, &extension_id, &window_id)? {
        win.set_title(&title)
            .map_err(|err| format!("failed to set extension window title: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn extension_window_set_size(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
    extension_id: String,
    window_id: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    ensure_command_owner(&caller, &extension_id, &state)?;
    let width = validate_positive_number(width, "width")?;
    let height = validate_positive_number(height, "height")?;
    if let Some((_, win)) = get_window_for_owner(&app, &state, &extension_id, &window_id)? {
        win.set_size(LogicalSize::new(width, height))
            .map_err(|err| format!("failed to set extension window size: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn extension_window_set_position(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
    extension_id: String,
    window_id: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    ensure_command_owner(&caller, &extension_id, &state)?;
    let x = validate_finite_number(x, "x")?;
    let y = validate_finite_number(y, "y")?;
    if let Some((_, win)) = get_window_for_owner(&app, &state, &extension_id, &window_id)? {
        win.set_position(LogicalPosition::new(x, y))
            .map_err(|err| format!("failed to set extension window position: {err}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn extension_window_get_current(
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
) -> Result<ExtensionWindowInfo, String> {
    let label = caller.label();
    if !is_extension_window_label(label) {
        return Err("current window is not an extension window".to_string());
    }
    state
        .get_by_label(label)
        .ok_or_else(|| "extension window ownership is not registered".to_string())
}

#[tauri::command]
pub fn extension_window_get_current_extension_files(
    app: AppHandle,
    caller: WebviewWindow,
    state: State<'_, ExtensionWindowState>,
) -> Result<Vec<ExtensionScriptFile>, String> {
    let current = extension_window_get_current(caller, state)?;

    let extension_dir = app
        .path()
        .resolve("extensions", BaseDirectory::AppData)
        .map_err(|err| format!("failed to resolve extension directory: {err}"))?;
    if !extension_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&extension_dir)
        .map_err(|err| format!("failed to read extension directory: {err}"))?;
    let mut sources = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|err| format!("failed to read extension entry: {err}"))?;
        let file_type = entry
            .file_type()
            .map_err(|err| format!("failed to read extension entry type: {err}"))?;
        if !file_type.is_file() {
            continue;
        }

        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !(file_name.ends_with(".js") || file_name.ends_with(".js.disabled")) {
            continue;
        }

        let script_data = fs::read_to_string(entry.path())
            .map_err(|err| format!("failed to read extension script {file_name}: {err}"))?;
        sources.push(parse_extension_script_source(file_name, script_data));
    }

    sources.sort_by(|a, b| a.file_name.cmp(&b.file_name));

    let mut sources_by_id: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, source) in sources.iter().enumerate() {
        if let Some(id) = &source.id {
            sources_by_id.entry(id.clone()).or_default().push(index);
        }
    }

    if !sources_by_id.contains_key(&current.extension_id) {
        return Err(format!(
            "missing extension script for current extension: {}",
            current.extension_id
        ));
    }

    let mut collected_indices = HashSet::new();
    collect_extension_file_indices(
        &current.extension_id,
        &sources,
        &sources_by_id,
        &mut HashSet::new(),
        &mut collected_indices,
    )?;

    let mut collected_sources = collected_indices.into_iter().collect::<Vec<_>>();
    collected_sources.sort_by(|a, b| sources[*a].file_name.cmp(&sources[*b].file_name));

    Ok(collected_sources
        .into_iter()
        .filter_map(|index| sources.get(index))
        .map(|source| ExtensionScriptFile {
            file_name: source.file_name.clone(),
            script_data: source.script_data.clone(),
        })
        .collect())
}

pub fn cleanup_destroyed_window(app: &AppHandle, label: &str) {
    if is_extension_window_label(label) {
        if let Some(state) = app.try_state::<ExtensionWindowState>() {
            state.remove_label(label);
        }
    }
}

pub fn destroy_all_extension_windows(app: &AppHandle) {
    let mut labels = Vec::new();

    if let Some(state) = app.try_state::<ExtensionWindowState>() {
        labels.extend(state.all_labels());
    }

    for label in app.webview_windows().keys() {
        if is_extension_window_label(label) && !labels.iter().any(|known| known == label) {
            labels.push(label.clone());
        }
    }

    for label in labels {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.destroy();
        }
        if let Some(state) = app.try_state::<ExtensionWindowState>() {
            state.remove_label(&label);
        }
    }
}
