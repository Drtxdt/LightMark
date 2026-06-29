mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::open_file_dialog,
            commands::file::open_folder_dialog,
            commands::file::save_markdown_file_dialog,
            commands::file::read_text_file,
            commands::file::get_file_info,
            commands::file::open_large_file,
            commands::file::read_file_chunk,
            commands::file::apply_file_edits,
            commands::file::search_large_file,
            commands::file::replace_large_file_matches,
            commands::file::save_large_file,
            commands::file::close_large_file,
            commands::file::write_text_file,
            commands::file::save_asset_file,
            commands::file::image_paths_to_markdown,
            commands::file::list_markdown_files,
            commands::file::find_similar_markdown_files,
            commands::file::create_markdown_file,
            commands::draft::write_draft,
            commands::draft::read_draft,
            commands::draft::delete_draft,
            commands::draft::list_drafts,
            commands::draft::get_file_snapshot,
            commands::export::export_document,
            commands::export::save_export_bytes,
            commands::export::detect_pandoc,
            commands::config::read_app_config,
            commands::config::write_app_config,
            commands::window::sync_window_chrome,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run LightMark");
}
