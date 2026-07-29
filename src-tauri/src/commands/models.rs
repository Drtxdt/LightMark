use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub recent_files: Vec<String>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub settings: AppSettings,
    #[serde(default)]
    pub session: Option<SessionRestoreState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionRestoreState {
    #[serde(default)]
    pub open_tabs: Vec<SessionTabState>,
    #[serde(default)]
    pub active_tab_key: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub split_layout: Option<SessionSplitLayoutState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionTabState {
    pub path: String,
    pub kind: String,
    pub editor_mode: String,
    pub last_active_at: u64,
    #[serde(default)]
    pub position: Option<EditorPositionSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionSplitLayoutState {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub active_pane_id: String,
    #[serde(default)]
    pub main_tab_keys: Vec<String>,
    #[serde(default)]
    pub secondary_tab_keys: Vec<String>,
    #[serde(default)]
    pub main_active_tab_key: Option<String>,
    #[serde(default)]
    pub secondary_active_tab_key: Option<String>,
    #[serde(default)]
    pub ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorPositionSnapshot {
    #[serde(default)]
    pub editor_mode: String,
    #[serde(default)]
    pub markdown_anchor: usize,
    #[serde(default)]
    pub markdown_head: usize,
    #[serde(default)]
    pub markdown_line: usize,
    #[serde(default)]
    pub markdown_column: usize,
    #[serde(default)]
    pub markdown_line_text: String,
    #[serde(default)]
    pub scroll_top: f64,
    #[serde(default)]
    pub scroll_ratio: f64,
    #[serde(default)]
    pub updated_at: u64,
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_roundtrip_preserves_workspace_split_and_position() {
        let value = json!({
            "recentFiles": [],
            "settings": {},
            "session": {
                "workspacePath": "E:\\notes",
                "activeTabKey": "E:\\notes\\main.md",
                "openTabs": [{
                    "path": "E:\\notes\\main.md",
                    "kind": "file",
                    "editorMode": "source",
                    "lastActiveAt": 42,
                    "position": {
                        "editorMode": "source",
                        "markdownAnchor": 12,
                        "markdownHead": 18,
                        "markdownLine": 3,
                        "markdownColumn": 4,
                        "markdownLineText": "heading",
                        "scrollTop": 120.5,
                        "scrollRatio": 0.25,
                        "updatedAt": 43
                    }
                }],
                "splitLayout": {
                    "enabled": true,
                    "activePaneId": "secondary",
                    "mainTabKeys": ["E:\\notes\\main.md"],
                    "secondaryTabKeys": ["E:\\notes\\other.md"],
                    "mainActiveTabKey": "E:\\notes\\main.md",
                    "secondaryActiveTabKey": "E:\\notes\\other.md",
                    "ratio": 0.55
                }
            }
        });

        let config: AppConfig = serde_json::from_value(value).expect("session config should deserialize");
        let serialized = serde_json::to_value(config).expect("session config should serialize");
        let session = &serialized["session"];

        assert_eq!(session["workspacePath"], "E:\\notes");
        assert_eq!(session["splitLayout"]["activePaneId"], "secondary");
        assert_eq!(session["splitLayout"]["ratio"], 0.55);
        assert_eq!(session["openTabs"][0]["position"]["markdownAnchor"], 12);
        assert_eq!(session["openTabs"][0]["position"]["scrollTop"], 120.5);
    }

    #[test]
    fn old_session_without_new_fields_remains_compatible() {
        let value = json!({
            "recentFiles": [],
            "settings": {},
            "session": {
                "openTabs": [],
                "activeTabKey": null
            }
        });

        let config: AppConfig = serde_json::from_value(value).expect("legacy config should deserialize");
        let session = config.session.expect("legacy session should remain present");
        assert!(session.workspace_path.is_none());
        assert!(session.split_layout.is_none());
    }

    #[test]
    fn math_numbering_defaults_and_roundtrips() {
        let legacy: AppConfig = serde_json::from_value(json!({
            "recentFiles": [],
            "settings": { "markdown": {} }
        }))
        .expect("legacy settings should deserialize");
        assert_eq!(legacy.settings.markdown.math_numbering, "none");

        let configured: AppConfig = serde_json::from_value(json!({
            "recentFiles": [],
            "settings": { "markdown": { "mathNumbering": "all-display" } }
        }))
        .expect("numbering settings should deserialize");
        let serialized = serde_json::to_value(configured).expect("settings should serialize");
        assert_eq!(serialized["settings"]["markdown"]["mathNumbering"], "all-display");
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub general: GeneralSettings,
    #[serde(default)]
    pub editor: EditorSettings,
    #[serde(default)]
    pub markdown: MarkdownSettings,
    #[serde(default)]
    pub image: ImageSettings,
    #[serde(default)]
    pub appearance: AppearanceSettings,
    #[serde(default)]
    pub export: ExportSettings,
    #[serde(default)]
    pub shortcuts: ShortcutSettings,
    #[serde(default)]
    pub advanced: AdvancedSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettings {
    #[serde(default = "default_launch_behavior")]
    pub launch_behavior: String,
    #[serde(default)]
    pub restore_last_file: bool,
    #[serde(default = "default_recent_files_limit")]
    pub recent_files_limit: u8,
    #[serde(default)]
    pub auto_save: bool,
    #[serde(default = "default_auto_save_interval_minutes")]
    pub auto_save_interval_minutes: u8,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default)]
    pub spellcheck: bool,
    #[serde(default = "default_spellcheck_language")]
    pub spellcheck_language: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettings {
    #[serde(default = "default_editor_mode")]
    pub default_mode: String,
    #[serde(default = "default_true")]
    pub auto_pair_brackets: bool,
    #[serde(default = "default_true")]
    pub auto_pair_markdown_syntax: bool,
    #[serde(default)]
    pub paste_markdown_as_plain_text: bool,
    #[serde(default)]
    pub focus_mode: bool,
    #[serde(default)]
    pub typewriter_mode: bool,
    #[serde(default = "default_true")]
    pub show_word_count: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownSettings {
    #[serde(default)]
    pub strict_mode: bool,
    #[serde(default = "default_true")]
    pub inline_html: bool,
    #[serde(default = "default_true")]
    pub block_html: bool,
    #[serde(default = "default_true")]
    pub math: bool,
    #[serde(default = "default_math_numbering")]
    pub math_numbering: String,
    #[serde(default = "default_true")]
    pub mermaid: bool,
    #[serde(default = "default_true")]
    pub footnotes: bool,
    #[serde(default = "default_true")]
    pub toc: bool,
    #[serde(default = "default_true")]
    pub task_list: bool,
    #[serde(default = "default_true")]
    pub github_alerts: bool,
    #[serde(default = "default_true")]
    pub yaml_front_matter: bool,
    #[serde(default = "default_true")]
    pub smart_punctuation: bool,
    #[serde(default = "default_true")]
    pub subscript: bool,
    #[serde(default = "default_true")]
    pub superscript: bool,
    #[serde(default = "default_true")]
    pub highlight: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSettings {
    #[serde(default = "default_image_insert_behavior")]
    pub insert_behavior: String,
    #[serde(default = "default_true")]
    pub use_relative_path: bool,
    #[serde(default)]
    pub ensure_dot_slash: bool,
    #[serde(default = "default_true")]
    pub escape_path: bool,
    #[serde(default = "default_asset_folder")]
    pub asset_folder: String,
    #[serde(default)]
    pub root_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceSettings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_editor_width")]
    pub editor_width: u16,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_font_size")]
    pub font_size: u8,
    #[serde(default = "default_line_height")]
    pub line_height: f32,
    #[serde(default = "default_paragraph_spacing")]
    pub paragraph_spacing: f32,
    #[serde(default = "default_code_font_family")]
    pub code_font_family: String,
    #[serde(default = "default_true")]
    pub show_sidebar: bool,
    #[serde(default = "default_true")]
    pub show_outline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    #[serde(default = "default_export_folder")]
    pub default_folder: String,
    #[serde(default)]
    pub custom_folder: String,
    #[serde(default = "default_html_theme")]
    pub html_theme: String,
    #[serde(default = "default_true")]
    pub html_include_styles: bool,
    #[serde(default)]
    pub include_yaml_front_matter: bool,
    #[serde(default)]
    pub allow_yaml_override: bool,
    #[serde(default)]
    pub open_file_after_export: bool,
    #[serde(default)]
    pub open_folder_after_export: bool,
    #[serde(default)]
    pub pandoc_path: String,
    #[serde(default = "default_true")]
    pub prefer_bundled_pandoc: bool,
    #[serde(default = "default_pdf_engine")]
    pub pdf_engine: String,
    #[serde(default = "default_pdf_paper_size")]
    pub pdf_paper_size: String,
    #[serde(default = "default_pdf_margin")]
    pub pdf_margin: String,
    #[serde(default)]
    pub docx_reference_doc: String,
    #[serde(default)]
    pub epub_cover_image: String,
    #[serde(default)]
    pub epub_css: String,
    #[serde(default)]
    pub custom_pandoc_format: String,
    #[serde(default = "default_custom_pandoc_extension")]
    pub custom_pandoc_extension: String,
    #[serde(default)]
    pub custom_pandoc_args: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSettings {
    #[serde(default)]
    pub custom_keybindings: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedSettings {
    #[serde(default)]
    pub debug_mode: bool,
    #[serde(default)]
    pub experimental_features: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub size_bytes: u64,
    pub line_count: usize,
    pub is_large: bool,
    pub encoding: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeOutlineItem {
    pub id: String,
    pub text: String,
    pub level: u8,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileSession {
    pub session_id: String,
    pub path: String,
    pub size_bytes: u64,
    pub total_lines: usize,
    pub outline: Vec<LargeOutlineItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChunk {
    pub session_id: String,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyState {
    pub is_dirty: bool,
    pub pending_edit_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRecord {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub pending_edits: Option<Vec<TextEdit>>,
    #[serde(default)]
    pub file_mtime: Option<u64>,
    #[serde(default)]
    pub file_size: Option<u64>,
    pub updated_at: u64,
    #[serde(default)]
    pub editor_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub exists: bool,
    #[serde(default)]
    pub mtime: Option<u64>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarFileCandidate {
    pub path: String,
    pub name: String,
    pub mtime: Option<u64>,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWatchEvent {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWatchEvent {
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFindOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFindMatch {
    pub line: usize,
    pub start_column: usize,
    pub end_column: usize,
    pub text: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFindResult {
    pub matches: Vec<LargeFindMatch>,
    pub total: usize,
    pub truncated: bool,
    pub error: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            recent_files: Vec::new(),
            theme: None,
            settings: AppSettings::default(),
            session: None,
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            general: GeneralSettings::default(),
            editor: EditorSettings::default(),
            markdown: MarkdownSettings::default(),
            image: ImageSettings::default(),
            appearance: AppearanceSettings::default(),
            export: ExportSettings::default(),
            shortcuts: ShortcutSettings::default(),
            advanced: AdvancedSettings::default(),
        }
    }
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            launch_behavior: default_launch_behavior(),
            restore_last_file: false,
            recent_files_limit: default_recent_files_limit(),
            auto_save: false,
            auto_save_interval_minutes: default_auto_save_interval_minutes(),
            language: default_language(),
            spellcheck: false,
            spellcheck_language: default_spellcheck_language(),
        }
    }
}

impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            default_mode: default_editor_mode(),
            auto_pair_brackets: true,
            auto_pair_markdown_syntax: true,
            paste_markdown_as_plain_text: false,
            focus_mode: false,
            typewriter_mode: false,
            show_word_count: true,
        }
    }
}

impl Default for MarkdownSettings {
    fn default() -> Self {
        Self {
            strict_mode: false,
            inline_html: true,
            block_html: true,
            math: true,
            math_numbering: default_math_numbering(),
            mermaid: true,
            footnotes: true,
            toc: true,
            task_list: true,
            github_alerts: true,
            yaml_front_matter: true,
            smart_punctuation: true,
            subscript: true,
            superscript: true,
            highlight: true,
        }
    }
}

impl Default for ImageSettings {
    fn default() -> Self {
        Self {
            insert_behavior: default_image_insert_behavior(),
            use_relative_path: true,
            ensure_dot_slash: false,
            escape_path: true,
            asset_folder: default_asset_folder(),
            root_url: String::new(),
        }
    }
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            editor_width: default_editor_width(),
            font_family: default_font_family(),
            font_size: default_font_size(),
            line_height: default_line_height(),
            paragraph_spacing: default_paragraph_spacing(),
            code_font_family: default_code_font_family(),
            show_sidebar: true,
            show_outline: true,
        }
    }
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            default_folder: default_export_folder(),
            custom_folder: String::new(),
            html_theme: default_html_theme(),
            html_include_styles: true,
            include_yaml_front_matter: false,
            allow_yaml_override: false,
            open_file_after_export: false,
            open_folder_after_export: false,
            pandoc_path: String::new(),
            prefer_bundled_pandoc: true,
            pdf_engine: default_pdf_engine(),
            pdf_paper_size: default_pdf_paper_size(),
            pdf_margin: default_pdf_margin(),
            docx_reference_doc: String::new(),
            epub_cover_image: String::new(),
            epub_css: String::new(),
            custom_pandoc_format: String::new(),
            custom_pandoc_extension: default_custom_pandoc_extension(),
            custom_pandoc_args: String::new(),
        }
    }
}

fn default_true() -> bool {
    true
}

fn default_theme() -> String {
    "system".to_string()
}

fn default_launch_behavior() -> String {
    "blank".to_string()
}

fn default_recent_files_limit() -> u8 {
    10
}

fn default_auto_save_interval_minutes() -> u8 {
    5
}

fn default_language() -> String {
    "system".to_string()
}

fn default_spellcheck_language() -> String {
    "en-US".to_string()
}

fn default_editor_mode() -> String {
    "wysiwyg".to_string()
}

fn default_math_numbering() -> String {
    "none".to_string()
}

fn default_image_insert_behavior() -> String {
    "reference".to_string()
}

fn default_asset_folder() -> String {
    "assets".to_string()
}

fn default_editor_width() -> u16 {
    860
}

fn default_font_family() -> String {
    "\"Open Sans\", \"Clear Sans\", \"Helvetica Neue\", Helvetica, Arial, sans-serif".to_string()
}

fn default_font_size() -> u8 {
    16
}

fn default_line_height() -> f32 {
    1.6
}

fn default_paragraph_spacing() -> f32 {
    0.8
}

fn default_code_font_family() -> String {
    "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Consolas, monospace".to_string()
}

fn default_export_folder() -> String {
    "auto".to_string()
}

fn default_pdf_paper_size() -> String {
    "a4".to_string()
}

fn default_pdf_engine() -> String {
    "xelatex".to_string()
}

fn default_pdf_margin() -> String {
    "20mm".to_string()
}

fn default_custom_pandoc_extension() -> String {
    ".html".to_string()
}

fn default_html_theme() -> String {
    "current".to_string()
}
