use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use std::time::UNIX_EPOCH;

use regex::{Regex, RegexBuilder};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const SCHEMA_VERSION: i64 = 2;
const ANALYZER_VERSION: i64 = 2;

mod service;
use service::{service as runtime, write_lock};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCandidate {
    path: String,
    name: String,
    aliases: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndexStatus {
    root: String,
    generation: u64,
    busy: bool,
    error: Option<String>,
    document_count: usize,
    candidates: Vec<WorkspaceCandidate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBacklink {
    source_path: String,
    source_name: String,
    line: usize,
    preview: String,
    target: WikiTarget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMention {
    source_path: String,
    source_name: String,
    line: usize,
    from: usize,
    to: usize,
    text: String,
    preview: String,
    target_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTag {
    name: String,
    normalized_name: String,
    paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiTarget {
    page: String,
    #[serde(default)]
    heading: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiResolution {
    status: String,
    path: Option<String>,
    candidates: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceQueryResponse<T> {
    generation: u64,
    document_revision: Option<u64>,
    data: T,
}

#[derive(Debug)]
struct Analysis {
    aliases: Vec<String>,
    tags: Vec<String>,
    links: Vec<LinkRecord>,
    segments: Vec<SegmentRecord>,
}

#[derive(Debug)]
struct LinkRecord {
    line: usize,
    from: usize,
    to: usize,
    page: String,
    heading: Option<String>,
    raw: String,
    preview: String,
}

#[derive(Debug)]
struct SegmentRecord {
    line: usize,
    from: usize,
    to: usize,
    text: String,
    preview: String,
}

#[tauri::command]
pub fn workspace_index_open(app: AppHandle, root: String) -> Result<WorkspaceIndexStatus, String> {
    let cache_dir = app.path().app_data_dir().map_err(|err| err.to_string())?.join("workspace-index");
    fs::create_dir_all(&cache_dir).map_err(|err| err.to_string())?;
    let db_path = cache_dir.join(format!("{}.sqlite3", workspace_hash(&root)));
    let generation = {
        let mut state = runtime().lock().map_err(|_| "Workspace index lock was poisoned.".to_string())?;
        state.root = root.clone();
        state.db_path = Some(db_path.clone());
        state.generation = state.generation.saturating_add(1);
        state.busy = true;
        state.error = None;
        state.revisions.clear();
        state.open_documents.clear();
        state.pending_paths.clear();
        state.generation
    };
    prepare_database(&db_path)?;
    let root_for_task = root.clone();
    let db_for_task = db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = rebuild_changed_files(&db_for_task, &root_for_task, generation);
        if let Ok(mut state) = runtime().lock() {
            if state.generation == generation {
                state.busy = false;
                state.error = result.err();
            }
        }
    });
    status_from_path(&db_path, root, generation, true, None)
}

#[tauri::command]
pub fn workspace_index_status() -> Result<WorkspaceIndexStatus, String> {
    let (path, root, generation, busy, error) = {
        let state = runtime().lock().map_err(|_| "Workspace index lock was poisoned.".to_string())?;
        let Some(path) = state.db_path.clone() else {
            return Ok(WorkspaceIndexStatus { root: String::new(), generation: state.generation, busy: false, error: state.error.clone(), document_count: 0, candidates: vec![] });
        };
        (path, state.root.clone(), state.generation, state.busy, state.error.clone())
    };
    status_from_path(&path, root, generation, busy, error)
}

#[tauri::command]
pub async fn workspace_index_update_open_document(path: String, revision: u64, markdown: String) -> Result<WorkspaceIndexStatus, String> {
    let (db_path, generation) = {
        let mut state = runtime().lock().map_err(|_| "Workspace index lock was poisoned.".to_string())?;
        if state.revisions.get(&path).is_some_and(|current| *current > revision) {
            let db = state.db_path.clone().ok_or_else(|| "Workspace index is not open.".to_string())?;
            let root = state.root.clone();
            let generation = state.generation;
            let busy = state.busy;
            let error = state.error.clone();
            drop(state);
            return status_from_path(&db, root, generation, busy, error);
        }
        state.revisions.insert(path.clone(), revision);
        state.open_documents.insert(path.clone());
        (state.db_path.clone().ok_or_else(|| "Workspace index is not open.".to_string())?, state.generation)
    };
    let path_for_task = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _write = write_lock()?;
        let current = runtime().lock().map_err(|_| "Workspace index lock was poisoned.".to_string())?;
        if current.generation != generation || current.revisions.get(&path_for_task) != Some(&revision) { return Ok(()); }
        drop(current);
        index_document(&db_path, &path_for_task, &markdown, None)
    })
        .await.map_err(|err| err.to_string())??;
    workspace_index_status()
}

#[tauri::command]
pub async fn workspace_index_release_open_document(path: String) -> Result<(), String> {
    let (db_path, generation) = {
        let mut state = runtime().lock().map_err(|_| "Workspace index lock was poisoned.".to_string())?;
        state.open_documents.remove(&path);
        state.revisions.remove(&path);
        (state.db_path.clone().ok_or_else(|| "Workspace index is not open.".to_string())?, state.generation)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _write = write_lock()?;
        let state = runtime().lock().map_err(|_| "Workspace index lock was poisoned.".to_string())?;
        if state.generation != generation || state.open_documents.contains(&path) { return Ok(()); }
        drop(state);
        let path_buf = PathBuf::from(&path);
        if !path_buf.exists() { return open_database(&db_path).and_then(|connection| delete_document(&connection, &path)); }
        let metadata = fs::metadata(&path_buf).map_err(|err| err.to_string())?;
        let markdown = fs::read_to_string(&path_buf).map_err(|err| err.to_string())?;
        let mtime = metadata.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok()).map(|value| value.as_millis() as i64).unwrap_or(0);
        index_document(&db_path, &path, &markdown, Some((mtime, metadata.len() as i64)))
    }).await.map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn workspace_query_backlinks(path: String) -> Result<WorkspaceQueryResponse<Vec<WorkspaceBacklink>>, String> {
    let context = active_query_context(Some(&path))?;
    let db = context.db_path.clone();
    let query_path = path.clone();
    let data = tauri::async_runtime::spawn_blocking(move || query_backlinks(&db, &query_path)).await.map_err(|err| err.to_string())??;
    Ok(context.response(data))
}

#[tauri::command]
pub async fn workspace_query_mentions(path: String) -> Result<WorkspaceQueryResponse<Vec<WorkspaceMention>>, String> {
    let context = active_query_context(Some(&path))?;
    let db = context.db_path.clone();
    let query_path = path.clone();
    let data = tauri::async_runtime::spawn_blocking(move || query_mentions(&db, &query_path)).await.map_err(|err| err.to_string())??;
    Ok(context.response(data))
}

#[tauri::command]
pub fn workspace_query_tags() -> Result<WorkspaceQueryResponse<Vec<WorkspaceTag>>, String> {
    let context = active_query_context(None)?;
    Ok(context.response(query_tags(&context.db_path)?))
}

#[tauri::command]
pub fn workspace_resolve_wiki_link(target: WikiTarget) -> Result<WorkspaceQueryResponse<WikiResolution>, String> {
    let context = active_query_context(None)?;
    Ok(context.response(resolve_target(&context.db_path, &target)?))
}

struct QueryContext {
    db_path: PathBuf,
    generation: u64,
    document_revision: Option<u64>,
}

impl QueryContext {
    fn response<T>(&self, data: T) -> WorkspaceQueryResponse<T> {
        WorkspaceQueryResponse { generation: self.generation, document_revision: self.document_revision, data }
    }
}

fn active_query_context(path: Option<&str>) -> Result<QueryContext, String> {
    let state = runtime().lock().map_err(|_| "Workspace index lock was poisoned.".to_string())?;
    Ok(QueryContext {
        db_path: state.db_path.clone().ok_or_else(|| "Workspace index is not open.".to_string())?,
        generation: state.generation,
        document_revision: path.and_then(|value| state.revisions.get(value).copied()),
    })
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|err| err.to_string())?;
    let has_meta = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta')",
        [],
        |row| row.get::<_, bool>(0),
    ).map_err(|err| err.to_string())?;
    if has_meta {
        let schema = connection.query_row("SELECT value FROM meta WHERE key='schema_version'", [], |row| row.get::<_, i64>(0)).unwrap_or(-1);
        let analyzer = connection.query_row("SELECT value FROM meta WHERE key='analyzer_version'", [], |row| row.get::<_, i64>(0)).unwrap_or(-1);
        if schema != SCHEMA_VERSION || analyzer != ANALYZER_VERSION {
            return Err("Workspace index cache version is incompatible.".to_string());
        }
        let integrity = connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0)).map_err(|err| err.to_string())?;
        if integrity != "ok" { return Err(format!("Workspace index cache is corrupt: {integrity}")); }
    }
    connection.pragma_update(None, "journal_mode", "WAL").map_err(|err| err.to_string())?;
    connection.execute_batch(&format!(r#"
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (
          path TEXT PRIMARY KEY, name TEXT NOT NULL, relative_path TEXT NOT NULL,
          aliases TEXT NOT NULL, tags TEXT NOT NULL, mtime INTEGER NOT NULL,
          size INTEGER NOT NULL, content_hash TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS aliases (
          document_path TEXT NOT NULL, value TEXT NOT NULL, normalized TEXT NOT NULL,
          PRIMARY KEY(document_path, normalized)
        );
        CREATE INDEX IF NOT EXISTS aliases_normalized ON aliases(normalized);
        CREATE TABLE IF NOT EXISTS tags (
          document_path TEXT NOT NULL, value TEXT NOT NULL, normalized TEXT NOT NULL,
          PRIMARY KEY(document_path, normalized)
        );
        CREATE INDEX IF NOT EXISTS tags_normalized ON tags(normalized);
        CREATE TABLE IF NOT EXISTS links (
          source_path TEXT NOT NULL, line INTEGER NOT NULL, from_offset INTEGER NOT NULL,
          to_offset INTEGER NOT NULL, page TEXT NOT NULL, heading TEXT, raw TEXT NOT NULL, preview TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS links_source ON links(source_path);
        CREATE TABLE IF NOT EXISTS segments (
          source_path TEXT NOT NULL, line INTEGER NOT NULL, from_offset INTEGER NOT NULL,
          to_offset INTEGER NOT NULL, text TEXT NOT NULL, preview TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS segments_source ON segments(source_path);
        CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(source_path UNINDEXED, text, tokenize='unicode61');
        INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', {SCHEMA_VERSION});
        INSERT OR REPLACE INTO meta(key, value) VALUES ('analyzer_version', {ANALYZER_VERSION});
    "#)).map_err(|err| err.to_string())?;
    Ok(connection)
}

fn prepare_database(path: &Path) -> Result<(), String> {
    match open_database(path) {
        Ok(connection) => { drop(connection); Ok(()) }
        Err(_) => {
            remove_database_cache(path)?;
            open_database(path).map(drop)
        }
    }
}

pub fn queue_workspace_paths(paths: Vec<String>) {
    let should_start = {
        let Ok(mut state) = runtime().lock() else { return; };
        if state.db_path.is_none() { return; }
        state.pending_paths.extend(paths);
        if state.worker_scheduled { false } else { state.worker_scheduled = true; true }
    };
    if !should_start { return; }
    thread::spawn(|| {
        thread::sleep(Duration::from_millis(100));
        let (paths, db_path, root, generation) = {
            let Ok(mut state) = runtime().lock() else { return; };
            state.worker_scheduled = false;
            let paths = state.pending_paths.drain().collect::<Vec<_>>();
            let Some(db_path) = state.db_path.clone() else { return; };
            (paths, db_path, state.root.clone(), state.generation)
        };
        let Ok(_write) = write_lock() else { return; };
        for path in paths {
            if runtime().lock().map(|state| state.generation != generation || state.open_documents.contains(&path)).unwrap_or(true) { continue; }
            let path_buf = PathBuf::from(&path);
            if !path_buf.exists() {
                if let Ok(connection) = open_database(&db_path) { let _ = delete_document(&connection, &path); }
                continue;
            }
            let Ok(metadata) = fs::metadata(&path_buf) else { continue; };
            let Ok(markdown) = fs::read_to_string(&path_buf) else { continue; };
            let mtime = metadata.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok()).map(|value| value.as_millis() as i64).unwrap_or(0);
            if Path::new(&path).starts_with(&root) { let _ = index_document(&db_path, &path, &markdown, Some((mtime, metadata.len() as i64))); }
        }
    });
}

fn rebuild_changed_files(db_path: &Path, root: &str, generation: u64) -> Result<(), String> {
    let connection = match open_database(db_path) {
        Ok(connection) => connection,
        Err(_) => {
            remove_database_cache(db_path)?;
            open_database(db_path)?
        }
    };
    let mut files = Vec::new();
    collect_markdown_files(Path::new(root), &mut files)?;
    let live: HashSet<String> = files.iter().map(|path| path.to_string_lossy().to_string()).collect();
    let mut existing = connection.prepare("SELECT path FROM documents").map_err(|err| err.to_string())?;
    let existing_paths = existing.query_map([], |row| row.get::<_, String>(0)).map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())?;
    drop(existing);
    for path in existing_paths.into_iter().filter(|path| !live.contains(path)) {
        let _write = write_lock()?;
        let state = runtime().lock().map_err(|_| "Workspace index lock was poisoned.".to_string())?;
        if state.generation != generation { return Ok(()); }
        if state.open_documents.contains(&path) { continue; }
        drop(state);
        delete_document(&connection, &path)?;
    }
    drop(connection);
    for path in files {
        let metadata = fs::metadata(&path).map_err(|err| err.to_string())?;
        let mtime = metadata.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok()).map(|value| value.as_millis() as i64).unwrap_or(0);
        let path_string = path.to_string_lossy().to_string();
        let _write = write_lock()?;
        let state = runtime().lock().map_err(|_| "Workspace index lock was poisoned.".to_string())?;
        if state.generation != generation { return Ok(()); }
        if state.open_documents.contains(&path_string) { continue; }
        drop(state);
        let connection = open_database(db_path)?;
        let existing = connection.query_row(
            "SELECT mtime,size,content_hash FROM documents WHERE path = ?1",
            params![path_string],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)),
        ).ok();
        drop(connection);
        if existing.as_ref().is_some_and(|(old_mtime, old_size, _)| *old_mtime == mtime && *old_size == metadata.len() as i64) { continue; }
        let markdown = fs::read_to_string(&path).map_err(|err| err.to_string())?;
        let hash = content_hash(&markdown);
        if existing.as_ref().is_some_and(|(_, _, old_hash)| *old_hash == hash) {
            let connection = open_database(db_path)?;
            connection.execute("UPDATE documents SET mtime=?2,size=?3 WHERE path=?1", params![path_string, mtime, metadata.len() as i64]).map_err(|err| err.to_string())?;
            continue;
        }
        index_document(db_path, &path_string, &markdown, Some((mtime, metadata.len() as i64)))?;
    }
    Ok(())
}

fn index_document(db_path: &Path, path: &str, markdown: &str, metadata: Option<(i64, i64)>) -> Result<(), String> {
    let mut connection = open_database(db_path)?;
    let transaction = connection.transaction().map_err(|err| err.to_string())?;
    delete_document(&transaction, path)?;
    let analysis = analyze(markdown);
    let root = runtime().lock().ok().map(|state| state.root.clone()).unwrap_or_default();
    let name = Path::new(path).file_stem().and_then(|value| value.to_str()).unwrap_or(path).to_string();
    let relative = Path::new(path).strip_prefix(&root).unwrap_or(Path::new(path)).to_string_lossy().to_string();
    let (mtime, size) = metadata.unwrap_or((0, markdown.len() as i64));
    transaction.execute(
        "INSERT INTO documents(path,name,relative_path,aliases,tags,mtime,size,content_hash) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![path, name, relative, serde_json::to_string(&analysis.aliases).unwrap_or_default(), serde_json::to_string(&analysis.tags).unwrap_or_default(), mtime, size, content_hash(markdown)],
    ).map_err(|err| err.to_string())?;
    for alias in &analysis.aliases {
        transaction.execute("INSERT INTO aliases(document_path,value,normalized) VALUES (?1,?2,?3)", params![path, alias, normalize_page(alias)]).map_err(|err| err.to_string())?;
    }
    for tag in &analysis.tags {
        transaction.execute("INSERT INTO tags(document_path,value,normalized) VALUES (?1,?2,?3)", params![path, tag, normalize_tag(tag)]).map_err(|err| err.to_string())?;
    }
    for link in analysis.links {
        transaction.execute("INSERT INTO links VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![path, link.line as i64, link.from as i64, link.to as i64, link.page, link.heading, link.raw, link.preview]).map_err(|err| err.to_string())?;
    }
    for segment in analysis.segments {
        transaction.execute("INSERT INTO segments_fts(source_path,text) VALUES (?1,?2)", params![path, segment.text]).map_err(|err| err.to_string())?;
        transaction.execute("INSERT INTO segments VALUES (?1,?2,?3,?4,?5,?6)", params![path, segment.line as i64, segment.from as i64, segment.to as i64, segment.text, segment.preview]).map_err(|err| err.to_string())?;
    }
    transaction.commit().map_err(|err| err.to_string())
}

fn delete_document(connection: &Connection, path: &str) -> Result<(), String> {
    connection.execute("DELETE FROM aliases WHERE document_path = ?1", [path]).map_err(|err| err.to_string())?;
    connection.execute("DELETE FROM tags WHERE document_path = ?1", [path]).map_err(|err| err.to_string())?;
    connection.execute("DELETE FROM links WHERE source_path = ?1", [path]).map_err(|err| err.to_string())?;
    connection.execute("DELETE FROM segments WHERE source_path = ?1", [path]).map_err(|err| err.to_string())?;
    connection.execute("DELETE FROM segments_fts WHERE source_path = ?1", [path]).map_err(|err| err.to_string())?;
    connection.execute("DELETE FROM documents WHERE path = ?1", [path]).map_err(|err| err.to_string())?;
    Ok(())
}

fn status_from_path(path: &Path, root: String, generation: u64, busy: bool, error: Option<String>) -> Result<WorkspaceIndexStatus, String> {
    let connection = open_database(path)?;
    let mut statement = connection.prepare("SELECT path,name,aliases FROM documents ORDER BY relative_path COLLATE NOCASE").map_err(|err| err.to_string())?;
    let candidates = statement.query_map([], |row| {
        let aliases_json: String = row.get(2)?;
        Ok(WorkspaceCandidate { path: row.get(0)?, name: row.get(1)?, aliases: serde_json::from_str(&aliases_json).unwrap_or_default() })
    }).map_err(|err| err.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())?;
    Ok(WorkspaceIndexStatus { root, generation, busy, error, document_count: candidates.len(), candidates })
}

fn query_backlinks(db: &Path, target_path: &str) -> Result<Vec<WorkspaceBacklink>, String> {
    let connection = open_database(db)?;
    let target = document_names(&connection, target_path)?;
    let mut statement = connection.prepare("SELECT l.source_path,d.name,l.line,l.preview,l.page,l.heading FROM links l JOIN documents d ON d.path=l.source_path WHERE l.source_path<>?1").map_err(|err| err.to_string())?;
    let rows = statement.query_map([target_path], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)? as usize, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?))).map_err(|err| err.to_string())?;
    let mut result = Vec::new();
    for row in rows {
        let (source_path, source_name, line, preview, page, heading) = row.map_err(|err| err.to_string())?;
        if target.contains(&normalize_page(&page)) {
            result.push(WorkspaceBacklink { source_path, source_name, line, preview, target: WikiTarget { page, heading } });
        }
    }
    Ok(result)
}

fn query_mentions(db: &Path, target_path: &str) -> Result<Vec<WorkspaceMention>, String> {
    let connection = open_database(db)?;
    let mut names = unique_aliases(document_display_names(&connection, target_path)?)
        .into_iter().filter(|value| is_eligible_mention_name(value)).collect::<Vec<_>>();
    names.sort_by(|left, right| right.chars().count().cmp(&left.chars().count()).then_with(|| left.cmp(right)));
    let mut statement = connection.prepare("SELECT s.source_path,d.name,s.line,s.from_offset,s.text,s.preview FROM segments s JOIN documents d ON d.path=s.source_path WHERE s.source_path<>?1").map_err(|err| err.to_string())?;
    let rows = statement.query_map([target_path], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)? as usize, row.get::<_, i64>(3)? as usize, row.get::<_, String>(4)?, row.get::<_, String>(5)?))).map_err(|err| err.to_string())?;
    let mut result = Vec::new();
    let mut occupied: HashMap<String, Vec<(usize, usize)>> = HashMap::new();
    for row in rows {
        let (source_path, source_name, line, base, text, preview) = row.map_err(|err| err.to_string())?;
        for name in &names {
            let matcher = RegexBuilder::new(&regex::escape(name)).case_insensitive(true).unicode(true).build().map_err(|err| err.to_string())?;
            for found in matcher.find_iter(&text) {
                if !mention_boundaries(&text, found.start(), found.end(), name) { continue; }
                let from = base + utf16_offset(&text, found.start());
                let to = base + utf16_offset(&text, found.end());
                let ranges = occupied.entry(source_path.clone()).or_default();
                if ranges.iter().any(|range| from < range.1 && to > range.0) { continue; }
                ranges.push((from, to));
                result.push(WorkspaceMention { source_path: source_path.clone(), source_name: source_name.clone(), line, from, to, text: found.as_str().to_string(), preview: preview.clone(), target_path: target_path.to_string() });
            }
        }
    }
    result.sort_by(|a, b| a.source_name.cmp(&b.source_name).then(a.line.cmp(&b.line)).then(a.from.cmp(&b.from)));
    Ok(result)
}

fn query_tags(db: &Path) -> Result<Vec<WorkspaceTag>, String> {
    let connection = open_database(db)?;
    let mut statement = connection.prepare("SELECT document_path,value,normalized FROM tags ORDER BY normalized,document_path").map_err(|err| err.to_string())?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).map_err(|err| err.to_string())?;
    let mut groups: HashMap<String, WorkspaceTag> = HashMap::new();
    for row in rows {
        let (path, tag, key) = row.map_err(|err| err.to_string())?;
        let entry = groups.entry(key.clone()).or_insert(WorkspaceTag { name: tag, normalized_name: key, paths: vec![] });
        entry.paths.push(path);
    }
    let mut result: Vec<_> = groups.into_values().collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

fn resolve_target(db: &Path, target: &WikiTarget) -> Result<WikiResolution, String> {
    let connection = open_database(db)?;
    let expected = normalize_page(&target.page);
    let mut statement = connection.prepare("SELECT d.path,d.name,EXISTS(SELECT 1 FROM aliases a WHERE a.document_path=d.path AND a.normalized=?1) FROM documents d").map_err(|err| err.to_string())?;
    let rows = statement.query_map([&expected], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, bool>(2)?))).map_err(|err| err.to_string())?;
    let mut name_candidates = Vec::new();
    let mut alias_candidates = Vec::new();
    for row in rows {
        let (path, name, alias_match) = row.map_err(|err| err.to_string())?;
        if normalize_page(&name) == expected { name_candidates.push(path); }
        else if alias_match { alias_candidates.push(path); }
    }
    let mut candidates = if name_candidates.is_empty() { alias_candidates } else { name_candidates };
    candidates.sort();
    Ok(WikiResolution { status: if candidates.is_empty() { "missing" } else if candidates.len() > 1 { "ambiguous" } else { "found" }.to_string(), path: candidates.first().cloned(), candidates })
}

fn document_names(connection: &Connection, path: &str) -> Result<HashSet<String>, String> {
    Ok(document_display_names(connection, path)?.into_iter().map(|value| normalize_page(&value)).collect())
}

fn document_display_names(connection: &Connection, path: &str) -> Result<Vec<String>, String> {
    let name = connection.query_row("SELECT name FROM documents WHERE path=?1", [path], |row| row.get::<_, String>(0)).map_err(|err| err.to_string())?;
    let mut statement = connection.prepare("SELECT value FROM aliases WHERE document_path=?1 ORDER BY rowid").map_err(|err| err.to_string())?;
    let mut values = vec![name];
    values.extend(statement.query_map([path], |row| row.get::<_, String>(0)).map_err(|err| err.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())?);
    Ok(values)
}

fn analyze(markdown: &str) -> Analysis {
    let wiki = Regex::new(r"\[\[([^\]\n]+)\]\]").unwrap();
    let tag_pattern = Regex::new(r"#[\p{L}\p{N}_-]+(?:/[\p{L}\p{N}_-]+)*").unwrap();
    let records = line_records(markdown);
    let mut protected = collect_protected_ranges(markdown, &records);
    let (aliases, mut tag_values) = parse_front_matter(markdown);
    let mut links = Vec::new();
    for captures in wiki.captures_iter(markdown) {
        let whole = captures.get(0).unwrap();
        if range_contains(&protected, whole.start()) { continue; }
        let body = captures.get(1).unwrap().as_str();
        let (page, heading) = body.split_once('#').map_or((body.trim().to_string(), None), |(page, heading)| (page.trim().to_string(), nonempty(heading)));
        if page.is_empty() { continue; }
        let line = line_for_offset(&records, whole.start());
        links.push(LinkRecord {
            line,
            from: utf16_offset(markdown, whole.start()),
            to: utf16_offset(markdown, whole.end()),
            page,
            heading,
            raw: whole.as_str().to_string(),
            preview: records[line].text(markdown).to_string(),
        });
        protected.push((whole.start(), whole.end()));
    }
    protected = merge_ranges(protected);
    for record in &records {
        for matched in tag_pattern.find_iter(record.text(markdown)) {
            let from = record.from + matched.start();
            let to = record.from + matched.end();
            let previous = markdown[..from].chars().next_back();
            let value = matched.as_str().trim_start_matches('#');
            if previous.is_some_and(|value| value == '\\' || value == '/' || value == '#' || value == '_' || value.is_alphanumeric())
                || !value.chars().any(char::is_alphabetic) || ranges_overlap(&protected, from, to) { continue; }
            if !tag_values.iter().any(|tag| normalize_tag(tag) == normalize_tag(value)) { tag_values.push(value.to_string()); }
            protected.push((from, to));
        }
    }
    let protected = merge_ranges(protected);
    let mut segments = Vec::new();
    for record in &records {
        let mut cursor = record.from;
        for (from, to) in protected.iter().copied().filter(|(from, to)| *from < record.to && *to > record.from) {
            let start = from.max(record.from);
            let end = to.min(record.to);
            if start > cursor { push_segment(&mut segments, markdown, cursor, start, record); }
            cursor = cursor.max(end);
        }
        if cursor < record.to { push_segment(&mut segments, markdown, cursor, record.to, record); }
    }
    Analysis { aliases: unique_aliases(aliases), tags: unique_tags(tag_values), links, segments }
}

#[derive(Clone, Copy)]
struct LineRecord { line: usize, from: usize, to: usize, end: usize }
impl LineRecord { fn text<'a>(&self, markdown: &'a str) -> &'a str { &markdown[self.from..self.to] } }

fn line_records(markdown: &str) -> Vec<LineRecord> {
    let mut records = Vec::new(); let mut from = 0; let mut line = 0;
    loop {
        let lf = markdown[from..].find('\n').map(|index| from + index);
        let raw_to = lf.unwrap_or(markdown.len());
        let to = if raw_to > from && markdown.as_bytes()[raw_to - 1] == b'\r' { raw_to - 1 } else { raw_to };
        records.push(LineRecord { line, from, to, end: lf.map_or(markdown.len(), |value| value + 1) });
        let Some(next) = lf.map(|value| value + 1) else { break; }; from = next; line += 1;
    }
    records
}

fn parse_front_matter(markdown: &str) -> (Vec<String>, Vec<String>) {
    let Some((_, _, yaml)) = front_matter(markdown) else { return (vec![], vec![]); };
    let Ok(serde_yaml::Value::Mapping(mapping)) = serde_yaml::from_str::<serde_yaml::Value>(yaml) else { return (vec![], vec![]); };
    let mut aliases = Vec::new(); let mut tags = Vec::new();
    for (key, value) in mapping {
        let Some(key) = key.as_str().map(str::to_lowercase) else { continue; };
        if key == "alias" || key == "aliases" { aliases.extend(yaml_strings(&value, false)); }
        if key == "tag" || key == "tags" { tags.extend(yaml_strings(&value, true)); }
    }
    (aliases, tags)
}

fn yaml_strings(value: &serde_yaml::Value, split: bool) -> Vec<String> {
    let values = match value { serde_yaml::Value::String(value) => vec![value.clone()], serde_yaml::Value::Sequence(items) => items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect(), _ => vec![] };
    values.into_iter().flat_map(|value| if split { value.split(|ch: char| ch.is_whitespace() || ch == ',').map(str::to_string).collect() } else { vec![value] }).map(|value| value.trim().trim_start_matches('#').to_string()).filter(|value| !value.is_empty()).collect()
}

fn front_matter(markdown: &str) -> Option<(usize, usize, &str)> {
    let records = line_records(markdown);
    if records.first()?.text(markdown).trim_start_matches('\u{feff}').trim_end() != "---" { return None; }
    for record in records.iter().skip(1) {
        if matches!(record.text(markdown).trim(), "---" | "...") { return Some((0, record.end, &markdown[records[0].end..record.from])); }
    }
    None
}

fn collect_protected_ranges(markdown: &str, records: &[LineRecord]) -> Vec<(usize, usize)> {
    enum BlockClose { Dollar, Bracket, Environment(String), HtmlComment, HtmlTag(String) }
    let mut ranges = Vec::new();
    if let Some((from, to, _)) = front_matter(markdown) { ranges.push((from, to)); }
    let mut fence: Option<(char, usize, usize)> = None;
    let mut block: Option<(BlockClose, usize)> = None;
    for record in records {
        if ranges.first().is_some_and(|(_, to)| record.from < *to) { continue; }
        let line = record.text(markdown); let trimmed = line.trim();
        if let Some((marker, length, from)) = fence {
            let close = trimmed.chars().take_while(|value| *value == marker).count();
            if close >= length && trimmed.chars().all(|value| value == marker || value.is_whitespace()) { ranges.push((from, record.end)); fence = None; }
            continue;
        }
        let leading = line.chars().take_while(|value| value.is_whitespace()).count();
        if leading <= 3 {
            let rest = &line[leading..];
            let marker = rest.chars().next();
            if matches!(marker, Some('`' | '~')) {
                let marker = marker.unwrap(); let length = rest.chars().take_while(|value| *value == marker).count();
                if length >= 3 { fence = Some((marker, length, record.from)); continue; }
            }
        }
        if let Some((close, from)) = block.as_ref() {
            let closes = match close {
                BlockClose::Dollar => trimmed.ends_with("$$"),
                BlockClose::Bracket => trimmed.ends_with("\\]"),
                BlockClose::Environment(value) => trimmed.contains(value),
                BlockClose::HtmlComment => line.contains("-->"),
                BlockClose::HtmlTag(value) => line.to_lowercase().contains(value),
            };
            if closes { ranges.push((*from, record.end)); block = None; }
            continue;
        }
        if trimmed.starts_with("$$") {
            if trimmed.len() > 4 && trimmed.ends_with("$$") { ranges.push((record.from, record.end)); }
            else { block = Some((BlockClose::Dollar, record.from)); }
            continue;
        }
        if trimmed.starts_with("\\[") {
            if trimmed.len() > 4 && trimmed.ends_with("\\]") { ranges.push((record.from, record.end)); }
            else { block = Some((BlockClose::Bracket, record.from)); }
            continue;
        }
        if let Some(name) = trimmed.strip_prefix("\\begin{").and_then(|value| value.split_once('}').map(|pair| pair.0)) {
            let close = format!("\\end{{{name}}}");
            if trimmed.contains(&close) { ranges.push((record.from, record.end)); } else { block = Some((BlockClose::Environment(close), record.from)); }
            continue;
        }
        if trimmed.starts_with("<!--") {
            if trimmed.contains("-->") { ranges.push((record.from, record.end)); } else { block = Some((BlockClose::HtmlComment, record.from)); }
            continue;
        }
        if let Some(tag) = html_block_tag(trimmed) {
            let close = format!("</{tag}>");
            if trimmed.to_lowercase().contains(&close) { ranges.push((record.from, record.end)); } else { block = Some((BlockClose::HtmlTag(close), record.from)); }
            continue;
        }
        collect_inline_ranges(line, record.from, &mut ranges);
    }
    if let Some((_, _, from)) = fence { ranges.push((from, markdown.len())); }
    if let Some((_, from)) = block { ranges.push((from, markdown.len())); }
    merge_ranges(ranges)
}

fn html_block_tag(value: &str) -> Option<String> {
    let lower = value.to_lowercase();
    ["script", "style", "pre", "iframe", "div", "section", "table", "details", "figure", "video", "audio"]
        .into_iter().find(|tag| lower.starts_with(&format!("<{tag}")) || lower.starts_with(&format!("<{tag} "))).map(str::to_string)
}

fn collect_inline_ranges(line: &str, offset: usize, ranges: &mut Vec<(usize, usize)>) {
    let bytes = line.as_bytes(); let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'`' { index += 1; continue; }
        let mut run = 1; while index + run < bytes.len() && bytes[index + run] == b'`' { run += 1; }
        let marker = "`".repeat(run);
        if let Some(close) = line[index + run..].find(&marker).map(|value| index + run + value) { ranges.push((offset + index, offset + close + run)); index = close + run; } else { index += run; }
    }
    let patterns = [r"!?\[[^\]\n]*\]\([^\)\n]*\)", r"<(?:(?:https?|mailto):[^>\n]+|/?[A-Za-z][^>\n]*)>", r"https?://[^\s<]+", r"\\.", r"\\\([^\n]*?\\\)"];
    for pattern in patterns { for found in Regex::new(pattern).unwrap().find_iter(line) { ranges.push((offset + found.start(), offset + found.end())); } }
    let mut cursor = 0;
    while let Some(found) = line[cursor..].find('$').map(|value| cursor + value) {
        if (found > 0 && bytes[found - 1] == b'\\') || (found + 1 < bytes.len() && bytes[found + 1] == b'$') { cursor = found + 1; continue; }
        let mut end = found + 1;
        while let Some(close) = line[end..].find('$').map(|value| end + value) {
            if close == 0 || bytes[close - 1] != b'\\' { ranges.push((offset + found, offset + close + 1)); end = close + 1; break; }
            end = close + 1;
        }
        cursor = end.max(found + 1);
    }
}

fn merge_ranges(mut ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    ranges.retain(|(from, to)| to > from); ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for range in ranges { if let Some(previous) = merged.last_mut().filter(|previous| range.0 <= previous.1) { previous.1 = previous.1.max(range.1); } else { merged.push(range); } }
    merged
}
fn range_contains(ranges: &[(usize, usize)], offset: usize) -> bool { ranges.iter().any(|(from, to)| offset >= *from && offset < *to) }
fn ranges_overlap(ranges: &[(usize, usize)], from: usize, to: usize) -> bool { ranges.iter().any(|range| from < range.1 && to > range.0) }
fn line_for_offset(records: &[LineRecord], offset: usize) -> usize { records.iter().position(|record| offset >= record.from && offset < record.end).unwrap_or(records.len().saturating_sub(1)) }
fn push_segment(output: &mut Vec<SegmentRecord>, markdown: &str, from: usize, to: usize, record: &LineRecord) {
    let text = &markdown[from..to];
    if !text.trim().is_empty() {
        output.push(SegmentRecord {
            line: record.line,
            from: utf16_offset(markdown, from),
            to: utf16_offset(markdown, to),
            text: text.to_string(),
            preview: record.text(markdown).to_string(),
        });
    }
}
fn utf16_offset(value: &str, byte_offset: usize) -> usize { value[..byte_offset].encode_utf16().count() }
fn nonempty(value: &str) -> Option<String> { let value = value.trim(); (!value.is_empty()).then(|| value.to_string()) }
fn unique_aliases(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values.into_iter().map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && seen.insert(normalize_page(value))).collect()
}
fn unique_tags(values: Vec<String>) -> Vec<String> {
    let valid = Regex::new(r"^[\p{L}\p{N}_-]+(?:/[\p{L}\p{N}_-]+)*$").unwrap();
    let mut seen = HashSet::new();
    values.into_iter().map(|value| value.trim().trim_start_matches('#').to_string())
        .filter(|value| valid.is_match(value) && value.chars().any(char::is_alphabetic) && seen.insert(normalize_tag(value))).collect()
}

fn collect_markdown_files(root: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|err| err.to_string())? {
        let entry = entry.map_err(|err| err.to_string())?;
        let path = entry.path();
        if path.is_dir() { collect_markdown_files(&path, output)?; }
        else if path.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case("md") || value.eq_ignore_ascii_case("markdown")) { output.push(path); }
    }
    Ok(())
}

fn mention_boundaries(value: &str, from: usize, to: usize, name: &str) -> bool {
    if !name.is_ascii() { return true; }
    let left = value[..from].chars().next_back();
    let right = value[to..].chars().next();
    !left.is_some_and(is_word_char) && !right.is_some_and(is_word_char)
}

fn is_word_char(value: char) -> bool { value.is_alphanumeric() || value == '_' }
fn is_eligible_mention_name(value: &str) -> bool {
    let length = value.trim().chars().count();
    if value.is_ascii() { length >= 3 } else { length >= 2 }
}
fn normalize_page(value: &str) -> String {
    let lower = value.trim().to_lowercase();
    lower.strip_suffix(".markdown").or_else(|| lower.strip_suffix(".md")).unwrap_or(&lower).to_string()
}
fn normalize_tag(value: &str) -> String { value.trim().trim_start_matches('#').to_lowercase() }
fn content_hash(value: &str) -> String { format!("{:x}", Sha256::digest(value.as_bytes())) }
fn workspace_hash(value: &str) -> String { content_hash(&value.to_lowercase())[..24].to_string() }

fn remove_database_cache(path: &Path) -> Result<(), String> {
    for candidate in [path.to_path_buf(), PathBuf::from(format!("{}-wal", path.display())), PathBuf::from(format!("{}-shm", path.display()))] {
        if candidate.exists() { fs::remove_file(&candidate).map_err(|err| err.to_string())?; }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_database(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("lightmark-{name}-{}-{}.sqlite3", std::process::id(), workspace_hash(name)))
    }

    #[test]
    fn analyzes_links_tags_and_front_matter() {
        let result = analyze("---\naliases: [Alpha, Beta]\ntags: math, notes\n---\n# Title\nSee [[Page#Part]] and #topic.\n```\n[[ignored]]\n```\n");
        assert_eq!(result.aliases, vec!["Alpha", "Beta"]);
        assert!(result.tags.contains(&"topic".to_string()));
        assert_eq!(result.links.len(), 1);
        assert_eq!(result.links[0].page, "Page");
    }

    #[test]
    fn mention_boundaries_reject_word_substrings() {
        assert!(!mention_boundaries("alphabet", 0, 5, "alpha"));
        assert!(mention_boundaries("alpha beta", 0, 5, "alpha"));
        assert!(mention_boundaries("前北京后", "前".len(), "前北京".len(), "北京"));
    }

    #[test]
    fn front_matter_supports_bom_multiline_yaml_and_filters_invalid_tags() {
        let result = analyze("\u{feff}---\naliases:\n  - 中文别名\n  - Alpha\ntags:\n  - '#研究/数学'\n  - '123'\n---\n正文 [[目标]]\n");
        assert_eq!(result.aliases, vec!["中文别名", "Alpha"]);
        assert_eq!(result.tags, vec!["研究/数学"]);
        assert_eq!(result.links.len(), 1);
    }

    #[test]
    fn protected_regions_do_not_produce_knowledge_tokens() {
        let result = analyze("`[[code]] #hidden` [text](target-[[hidden2]]) $[[math]] #math$ [[shown]] #shown\n<!-- [[comment]] #comment -->\n");
        assert_eq!(result.links.iter().map(|link| link.page.as_str()).collect::<Vec<_>>(), vec!["shown"]);
        assert_eq!(result.tags, vec!["shown"]);
    }

    #[test]
    fn exported_offsets_are_utf16_code_units() {
        let result = analyze("😀前 [[目标]] 后 #标签");
        assert_eq!(result.links[0].from, "😀前 ".encode_utf16().count());
        assert_eq!(result.links[0].to, "😀前 [[目标]]".encode_utf16().count());
    }

    #[test]
    fn sqlite_index_round_trips_normalized_knowledge_tables() {
        let db = test_database("knowledge-roundtrip");
        let _ = remove_database_cache(&db);
        prepare_database(&db).unwrap();
        runtime().lock().unwrap().root = "C:/vault".to_string();
        index_document(&db, "C:/vault/Target.md", "---\naliases: [Alpha, 项目甲]\ntags: [Research, 中文]\n---\n# Target\n", None).unwrap();
        index_document(&db, "C:/vault/Source.md", "😀 Alpha and 项目甲 plus [[Alpha#Part]].\n", None).unwrap();
        let tags = query_tags(&db).unwrap();
        assert_eq!(tags.iter().map(|tag| tag.normalized_name.as_str()).collect::<Vec<_>>(), vec!["research", "中文"]);
        assert_eq!(resolve_target(&db, &WikiTarget { page: "项目甲".to_string(), heading: None }).unwrap().path.as_deref(), Some("C:/vault/Target.md"));
        assert_eq!(query_backlinks(&db, "C:/vault/Target.md").unwrap().len(), 1);
        let mentions = query_mentions(&db, "C:/vault/Target.md").unwrap();
        assert_eq!(mentions.iter().map(|mention| mention.text.as_str()).collect::<Vec<_>>(), vec!["Alpha", "项目甲"]);
        assert_eq!(mentions[0].from, "😀 ".encode_utf16().count());
        remove_database_cache(&db).unwrap();
    }

    #[test]
    fn incompatible_schema_cache_is_deleted_and_rebuilt() {
        let db = test_database("schema-rebuild");
        let _ = remove_database_cache(&db);
        prepare_database(&db).unwrap();
        let connection = Connection::open(&db).unwrap();
        connection.execute("UPDATE meta SET value=0 WHERE key='schema_version'", []).unwrap();
        drop(connection);
        prepare_database(&db).unwrap();
        let connection = open_database(&db).unwrap();
        let schema = connection.query_row("SELECT value FROM meta WHERE key='schema_version'", [], |row| row.get::<_, i64>(0)).unwrap();
        assert_eq!(schema, SCHEMA_VERSION);
        drop(connection);
        remove_database_cache(&db).unwrap();
    }
}
