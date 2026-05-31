mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::open_file_dialog,
            commands::file::open_folder_dialog,
            commands::file::read_text_file,
            commands::file::get_file_info,
            commands::file::open_large_file,
            commands::file::read_file_chunk,
            commands::file::apply_file_edits,
            commands::file::save_large_file,
            commands::file::close_large_file,
            commands::file::write_text_file,
            commands::file::list_markdown_files,
            commands::file::create_markdown_file,
            commands::export::export_html,
            commands::config::read_app_config,
            commands::config::write_app_config,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LightMark");
}
