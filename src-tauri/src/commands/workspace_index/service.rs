use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

/// Process-local coordinator for the rebuildable workspace cache. The active
/// generation owns its root, database and coalesced watcher queue; workers must
/// compare the generation before committing results.
#[derive(Default)]
pub(super) struct WorkspaceIndexService {
    pub(super) root: String,
    pub(super) db_path: Option<PathBuf>,
    pub(super) generation: u64,
    pub(super) busy: bool,
    pub(super) error: Option<String>,
    pub(super) revisions: HashMap<String, u64>,
    pub(super) open_documents: HashSet<String>,
    pub(super) pending_paths: HashSet<String>,
    pub(super) worker_scheduled: bool,
}

static SERVICE: OnceLock<Mutex<WorkspaceIndexService>> = OnceLock::new();
static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) fn service() -> &'static Mutex<WorkspaceIndexService> {
    SERVICE.get_or_init(|| Mutex::new(WorkspaceIndexService::default()))
}

pub(super) fn write_lock() -> Result<MutexGuard<'static, ()>, String> {
    WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Workspace index write lock was poisoned.".to_string())
}
