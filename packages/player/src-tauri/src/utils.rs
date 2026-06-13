use std::path::Path;

/// Detect file type via magic bytes and return the canonical cover extension:
/// video → "mp4", image → "jpg".
pub fn cover_ext_for_path(path: &Path) -> &str {
    if let Ok(Some(kind)) = infer::get_from_path(path)
        && kind.mime_type().starts_with("video/")
    {
        return "mp4";
    }

    "jpg"
}
