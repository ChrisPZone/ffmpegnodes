mod ffmpeg;
mod letterbox;

use std::collections::HashMap;
use std::sync::Mutex;

/// Shared state: running ffmpeg jobs, keyed by the job id the frontend picks.
#[derive(Default)]
pub struct Jobs(pub Mutex<HashMap<String, ffmpeg::JobHandle>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Jobs::default())
        .invoke_handler(tauri::generate_handler![
            ffmpeg::get_capabilities,
            ffmpeg::probe_file,
            ffmpeg::list_gpus,
            ffmpeg::filter_help,
            letterbox::detect_letterbox,
            ffmpeg::run_job,
            ffmpeg::cancel_job,
            ffmpeg::read_text_file,
            ffmpeg::write_text_file,
            ffmpeg::list_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
