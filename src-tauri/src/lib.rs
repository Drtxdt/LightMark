mod commands;
pub mod export_destination;
mod profile;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    let selected_profile = profile::select_profile(
        std::env::args_os().skip(1),
        std::env::var_os("LIGHTMARK_PROFILE"),
    ).unwrap_or_else(|error| {
        eprintln!("LightMark: {error}");
        std::process::exit(2);
    });
    if let Some(name) = selected_profile {
        context.config_mut().identifier = profile::profile_identifier(&name)
            .expect("profile was validated before creating the application");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::cli::get_headless_export_request,
            commands::cli::trace_headless_frontend,
            commands::cli::complete_headless_export,
            commands::file::open_file_dialog,
            commands::file::open_folder_dialog,
            commands::file::open_asset_file_dialog,
            commands::file::save_markdown_file_dialog,
            commands::file::read_text_file,
            commands::file::read_text_file_snapshot,
            commands::file::get_file_info,
            commands::file::open_large_file,
            commands::file::read_file_chunk,
            commands::file::read_file_range,
            commands::file::read_large_preview_range,
            commands::file::resolve_large_position,
            commands::large_jobs::start_large_search_job,
            commands::large_jobs::start_large_replace_job,
            commands::large_jobs::poll_large_job,
            commands::large_jobs::cancel_large_job,
            commands::file::apply_file_operation,
            commands::file::move_large_history,
            commands::file::export_large_range,
            commands::file::apply_file_edits,
            commands::file::save_large_file,
            commands::file::save_large_file_as,
            commands::file::close_large_file,
            commands::large_draft::capture_large_file_draft,
            commands::large_draft::open_large_file_draft,
            commands::large_draft::delete_large_file_draft,
            commands::large_draft::get_large_file_fingerprint,
            commands::file::write_text_file,
            commands::file::save_asset_file,
            commands::file::inspect_document_assets,
            commands::file::watch_asset_folder,
            commands::file::unwatch_asset_folder,
            commands::file::image_paths_to_markdown,
            commands::file::asset_path_to_reference,
            commands::file::list_markdown_files,
            commands::file::watch_markdown_file,
            commands::file::unwatch_markdown_file,
            commands::file::unwatch_all_markdown_files,
            commands::file::watch_markdown_workspace,
            commands::file::unwatch_markdown_workspace,
            commands::file::find_similar_markdown_files,
            commands::file::create_markdown_file,
            commands::draft::write_draft,
            commands::draft::read_draft,
            commands::draft::delete_draft,
            commands::draft::list_drafts,
            commands::draft::get_file_snapshot,
            commands::export::export_document,
            commands::export::read_export_resource,
            commands::export::save_export_bytes,
            commands::export::detect_pandoc,
            commands::config::read_app_config,
            commands::config::write_app_config,
            commands::window::sync_window_chrome,
            commands::workspace_index::workspace_index_open,
            commands::workspace_index::workspace_index_status,
            commands::workspace_index::workspace_index_update_open_document,
            commands::workspace_index::workspace_index_release_open_document,
            commands::workspace_index::workspace_query_backlinks,
            commands::workspace_index::workspace_query_mentions,
            commands::workspace_index::workspace_query_tags,
            commands::workspace_index::workspace_resolve_wiki_link,
        ])
        .run(context)
        .expect("failed to run LightMark");
}
