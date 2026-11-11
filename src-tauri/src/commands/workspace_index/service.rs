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
    pub(super) documents: HashMap<String, DocumentIndexVersion>,
    pub(super) pending_paths: HashSet<String>,
    pub(super) worker_scheduled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct DocumentIndexVersion {
    pub(super) epoch: u64,
    pub(super) revision: u64,
    pub(super) open: bool,
}

fn document_key(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if cfg!(windows) { normalized.to_lowercase() } else { normalized }
}

impl WorkspaceIndexService {
    pub(super) fn version(&self, path: &str) -> Option<DocumentIndexVersion> {
        self.documents.get(&document_key(path)).copied()
    }

    pub(super) fn is_open(&self, path: &str) -> bool {
        self.version(path).is_some_and(|version| version.open)
    }

    pub(super) fn accept_update(&mut self, path: &str, epoch: u64, revision: u64) -> bool {
        if self.version(path).is_some_and(|current| epoch < current.epoch
            || epoch == current.epoch && (!current.open || revision < current.revision)) {
            return false;
        }
        self.documents.insert(document_key(path), DocumentIndexVersion { epoch, revision, open: true });
        true
    }

    pub(super) fn accept_release(&mut self, path: &str, epoch: u64, revision: u64) -> bool {
        if self.version(path).is_some_and(|current| epoch < current.epoch
            || epoch == current.epoch && revision < current.revision) {
            return false;
        }
        // Keep the closed version: removing it would let an old queued update reopen the path.
        self.documents.insert(document_key(path), DocumentIndexVersion { epoch, revision, open: false });
        true
    }

    pub(super) fn matches(&self, generation: u64, path: &str, epoch: u64, revision: u64, open: bool) -> bool {
        self.generation == generation && self.version(path) == Some(DocumentIndexVersion { epoch, revision, open })
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_epoch_rejects_late_updates_even_with_higher_revisions() {
        let mut state = WorkspaceIndexService::default();
        assert!(state.accept_update("note.md", 10, 300));
        assert!(state.accept_release("note.md", 10, 301));
        assert!(!state.is_open("note.md"));
        assert!(!state.accept_update("note.md", 10, 999));
        assert!(!state.accept_update("note.md", 9, 1000));
        assert_eq!(state.version("note.md"), Some(DocumentIndexVersion { epoch: 10, revision: 301, open: false }));
    }

    #[test]
    fn reopen_accepts_reset_revision_but_rejects_old_update_and_release() {
        let mut state = WorkspaceIndexService::default();
        state.generation = 4;
        assert!(state.accept_update("note.md", 10, 300));
        assert!(state.accept_release("note.md", 10, 300));
        assert!(state.accept_update("note.md", 11, 0));
        assert!(!state.accept_update("note.md", 10, 9999));
        assert!(!state.accept_release("note.md", 10, 9999));
        assert!(state.matches(4, "note.md", 11, 0, true));
        assert!(!state.matches(4, "note.md", 10, 300, false), "old release disk refill must be discarded");
        assert!(!state.matches(4, "note.md", 10, 300, true), "old queued update must be discarded");
    }

    #[test]
    fn release_before_first_snapshot_keeps_a_tombstone() {
        let mut state = WorkspaceIndexService::default();
        assert!(state.accept_release("note.md", 20, 0));
        assert!(!state.accept_update("note.md", 20, 1));
        assert!(!state.accept_release("note.md", 19, 900));
        assert!(state.accept_update("note.md", 21, 0));
    }

    #[test]
    fn pending_workers_require_exact_generation_epoch_revision_and_open_state() {
        let mut state = WorkspaceIndexService::default();
        state.generation = 7;
        assert!(state.accept_update("note.md", 30, 3));
        assert!(state.matches(7, "note.md", 30, 3, true));
        assert!(!state.matches(6, "note.md", 30, 3, true));
        assert!(!state.matches(7, "note.md", 29, 3, true));
        assert!(!state.matches(7, "note.md", 30, 2, true));
        assert!(!state.matches(7, "note.md", 30, 3, false));
        assert!(state.accept_update("note.md", 30, 4));
        assert!(!state.matches(7, "note.md", 30, 3, true));
        assert!(!state.accept_release("note.md", 30, 3));
        assert!(state.accept_release("note.md", 30, 4));
        assert!(state.matches(7, "note.md", 30, 4, false));
        assert!(!state.matches(7, "note.md", 30, 4, true));
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_and_slash_variants_share_the_same_epoch_fence() {
        let mut state = WorkspaceIndexService::default();
        assert!(state.accept_update("C:\\Vault\\Note.md", 50, 1));
        assert!(state.accept_release("c:/vault/note.md", 50, 1));
        assert!(!state.accept_update("C:/VAULT/NOTE.MD", 50, 2));
        assert!(state.accept_update("C:/VAULT/NOTE.MD", 51, 0));
        assert!(!state.accept_release("c:/vault/note.md", 50, 999));
    }
}
