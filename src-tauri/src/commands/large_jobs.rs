//! Background work owns a captured immutable root. Replacement publishes one
//! disk-backed root only after the originating session/revision passes again.
use super::{
    file::{capture_large_job, commit_large_job, LargeJobSource},
    large_file_base::FileBaseSnapshot,
    models::{
        LargeCoordinateSpace, LargeFileError, LargeFindMatch, LargeFindOptions, LargeFindResult,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobReceipt {
    pub job_id: String,
    pub session_id: String,
    pub revision: u64,
    pub coordinate_space: LargeCoordinateSpace,
    pub kind: String,
    pub status: String,
    pub progress: f64,
    pub phase: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}
struct Job {
    state: Mutex<JobReceipt>,
    cancel: Arc<AtomicBool>,
    finished_at: AtomicU64,
}
static JOBS: OnceLock<Mutex<HashMap<String, Arc<Job>>>> = OnceLock::new();
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static REAPER: OnceLock<()> = OnceLock::new();
fn seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn registry() -> &'static Mutex<HashMap<String, Arc<Job>>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn error(message: impl Into<String>) -> LargeFileError {
    LargeFileError::new("large-job-failed", message.into())
}
impl Job {
    fn checkpoint(&self, progress: f64, phase: &str) -> Result<(), LargeFileError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(error("cancelled"));
        }
        if let Ok(mut state) = self.state.lock() {
            state.progress = progress.clamp(0., 1.);
            state.phase = phase.into();
        }
        Ok(())
    }
    fn finish(&self, result: Result<serde_json::Value, LargeFileError>) {
        self.finished_at.store(seconds(), Ordering::Relaxed);
        if let Ok(mut state) = self.state.lock() {
            match result {
                Ok(value) => {
                    state.status = "completed".into();
                    state.progress = 1.;
                    state.result = Some(value)
                }
                Err(e) => {
                    state.status = if self.cancel.load(Ordering::Relaxed) {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                    state.error = Some(e.message);
                }
            }
        }
    }
}
struct OwnedPath(PathBuf);
impl Drop for OwnedPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
struct ProgressWriter<'a> {
    file: File,
    job: &'a Job,
    written: u64,
    total: u64,
    from: f64,
    span: f64,
}
impl Write for ProgressWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.job
            .checkpoint(
                self.from + self.span * self.written as f64 / self.total.max(1) as f64,
                "snapshot",
            )
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.message))?;
        let size = self.file.write(bytes)?;
        self.written += size as u64;
        Ok(size)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

fn start(
    session_id: String,
    revision: u64,
    coordinate_space: LargeCoordinateSpace,
    query: String,
    options: LargeFindOptions,
    replacement: Option<String>,
    current_match: Option<LargeFindMatch>,
    start_line: usize,
    limit: usize,
) -> Result<JobReceipt, LargeFileError> {
    if query.is_empty() {
        return Err(error("search query must not be empty"));
    }
    REAPER.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_secs(15));
            if let Ok(mut jobs) = registry().lock() {
                let now = seconds();
                jobs.retain(|_, job| {
                    let finished = job.finished_at.load(Ordering::Relaxed);
                    finished == 0 || now.saturating_sub(finished) < 60
                });
            }
        });
    });
    let source = capture_large_job(&session_id, revision, replacement.is_some())?;
    let job_id = format!(
        "large-job-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let receipt = JobReceipt {
        job_id: job_id.clone(),
        session_id,
        revision,
        coordinate_space,
        kind: if replacement.is_some() {
            "replace"
        } else {
            "search"
        }
        .into(),
        status: "running".into(),
        progress: 0.,
        phase: "snapshot".into(),
        result: None,
        error: None,
    };
    let job = Arc::new(Job {
        state: Mutex::new(receipt.clone()),
        cancel: Arc::new(AtomicBool::new(false)),
        finished_at: AtomicU64::new(0),
    });
    let mut jobs = registry()
        .lock()
        .map_err(|_| error("job registry lock poisoned"))?;
    if jobs
        .values()
        .filter(|j| j.finished_at.load(Ordering::Relaxed) == 0)
        .count()
        >= 4
    {
        return Err(error("four large-file jobs are already running"));
    }
    if jobs.len() > 128 {
        jobs.retain(|_, j| {
            j.state
                .lock()
                .map_or(true, |state| state.status == "running")
        });
    }
    jobs.insert(job_id.clone(), job.clone());
    drop(jobs);
    let worker = job.clone();
    let captured = receipt.clone();
    std::thread::spawn(move || {
        let result = run(
            &worker,
            &captured,
            &source,
            &query,
            &options,
            replacement.as_deref(),
            current_match.as_ref(),
            start_line,
            limit,
        );
        // A completed receipt also means the captured input root was released.
        // Otherwise an immediate close can race a still-owned snapshot handle.
        drop(source);
        worker.finish(result);
    });
    Ok(receipt)
}
#[tauri::command(async)]
pub fn start_large_search_job(
    session_id: String,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
    query: String,
    options: LargeFindOptions,
    start_line: Option<usize>,
    limit: Option<usize>,
) -> Result<JobReceipt, LargeFileError> {
    start(
        session_id,
        expected_revision,
        coordinate_space,
        query,
        options,
        None,
        None,
        start_line.unwrap_or(0),
        limit.unwrap_or(2000).clamp(1, 10_000),
    )
}
#[tauri::command(async)]
pub fn start_large_replace_job(
    session_id: String,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
    query: String,
    replacement: String,
    options: LargeFindOptions,
    current_match: Option<LargeFindMatch>,
) -> Result<JobReceipt, LargeFileError> {
    start(
        session_id,
        expected_revision,
        coordinate_space,
        query,
        options,
        Some(replacement),
        current_match,
        0,
        0,
    )
}
fn lookup(
    job_id: &str,
    session_id: &str,
    revision: u64,
    coordinate_space: LargeCoordinateSpace,
) -> Result<Arc<Job>, LargeFileError> {
    let job = registry()
        .lock()
        .map_err(|_| error("job registry lock poisoned"))?
        .get(job_id)
        .cloned()
        .ok_or_else(|| LargeFileError::new("large-job-not-found", "job not found"))?;
    {
        let state = job
            .state
            .lock()
            .map_err(|_| error("job state lock poisoned"))?;
        if state.session_id != session_id
            || state.revision != revision
            || state.coordinate_space != coordinate_space
        {
            return Err(error("job identity does not match request"));
        }
    }
    Ok(job)
}
fn retained_completion(job_id:String,session_id:String,revision:u64,coordinate_space:LargeCoordinateSpace)->Result<JobReceipt,LargeFileError>{
    let result=super::file::completed_large_job_receipt(&session_id,&job_id,revision)?;
    if result.state.coordinate_space!=coordinate_space{return Err(error("job coordinate space does not match request"));}
    Ok(JobReceipt{job_id,session_id,revision,coordinate_space,kind:"replace".into(),status:"completed".into(),progress:1.,phase:"commit".into(),result:Some(serde_json::to_value(result).map_err(|e|error(e.to_string()))?),error:None})
}
#[tauri::command(async)]
pub fn poll_large_job(
    job_id: String,
    session_id: String,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
) -> Result<JobReceipt, LargeFileError> {
    let job = match lookup(&job_id, &session_id, expected_revision, coordinate_space){
        Ok(job)=>job,
        Err(failure) if failure.code=="large-job-not-found"=>return retained_completion(job_id,session_id,expected_revision,coordinate_space),
        Err(failure)=>return Err(failure),
    };
    let state = job
        .state
        .lock()
        .map_err(|_| error("job state lock poisoned"))?
        .clone();
    Ok(state)
}
#[tauri::command(async)]
pub fn cancel_large_job(
    job_id: String,
    session_id: String,
    expected_revision: u64,
    coordinate_space: LargeCoordinateSpace,
) -> Result<JobReceipt, LargeFileError> {
    let job = match lookup(&job_id, &session_id, expected_revision, coordinate_space){
        Ok(job)=>job,
        Err(failure) if failure.code=="large-job-not-found"=>return retained_completion(job_id,session_id,expected_revision,coordinate_space),
        Err(failure)=>return Err(failure),
    };
    job.cancel.store(true, Ordering::Relaxed);
    let state = job
        .state
        .lock()
        .map_err(|_| error("job state lock poisoned"))?
        .clone();
    Ok(state)
}

fn run(
    job: &Job,
    identity: &JobReceipt,
    source: &LargeJobSource,
    query: &str,
    options: &LargeFindOptions,
    replacement: Option<&str>,
    current_match: Option<&LargeFindMatch>,
    start_line: usize,
    limit: usize,
) -> Result<serde_json::Value, LargeFileError> {
    let raw = OwnedPath(
        source
            .snapshot_root
            .join(format!("{}-input.tmp", identity.job_id)),
    );
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&raw.0)
        .map_err(|e| error(e.to_string()))?;
    let mut writer = ProgressWriter {
        file,
        job,
        written: 0,
        total: source.view.byte_length(),
        from: 0.,
        span: 0.3,
    };
    source
        .view
        .write_to(&mut writer)
        .map_err(|e| error(e.to_string()))?;
    writer.flush().map_err(|e| error(e.to_string()))?;
    drop(writer);
    job.checkpoint(0.3, "scan")?;
    let file = File::open(&raw.0).map_err(|e| error(e.to_string()))?;
    // The private file has no writable handle and is never modified while the
    // mapping exists. No mutable external source path is mapped.
    let mapping = if file.metadata().map_err(|e| error(e.to_string()))?.len() > 0 {
        Some(unsafe { memmap2::MmapOptions::new().map(&file) }.map_err(|e| error(e.to_string()))?)
    } else {
        None
    };
    let bytes = mapping.as_deref().unwrap_or(&[]);
    let text = std::str::from_utf8(bytes).map_err(|e| error(e.to_string()))?;
    let bom = usize::from(text.starts_with('\u{feff}')) * 3;
    let text = &text[bom..];
    let pattern = if options.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let regex = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .multi_line(true)
        .build()
        .map_err(|e| error(e.to_string()))?;
    let only_range = if let Some(item) = current_match {
        Some((
            source
                .view
                .position_byte(item.line, item.start_column)
                .map_err(|e| error(e.to_string()))? as usize,
            source
                .view
                .position_byte(item.end_line.unwrap_or(item.line), item.end_column)
                .map_err(|e| error(e.to_string()))? as usize,
        ))
    } else {
        None
    };
    let mut matches = Vec::new();
    let mut total = 0;
    let mut last = 0;
    let candidate = OwnedPath(
        source
            .snapshot_root
            .join(format!("{}-candidate.tmp", identity.job_id)),
    );
    let mut output = if replacement.is_some() {
        Some(
            OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&candidate.0)
                .map_err(|e| error(e.to_string()))?,
        )
    } else {
        None
    };
    if let Some(output) = output.as_mut() {
        if bom > 0 {
            output
                .write_all(&bytes[..bom])
                .map_err(|e| error(e.to_string()))?;
        }
    }
    let minimum_byte = if start_line > source.view.line_count() {
        usize::MAX
    } else {
        source.view.position_byte(start_line, 0).map_err(|e| error(e.to_string()))? as usize
    };
    visit_matches(
        &regex,
        text,
        query,
        !options.regex,
        job,
        |captures, offset| {
            let found = captures.get(0).unwrap();
            let found_start = offset + found.start();
            let found_end = offset + found.end();
            if found_start < minimum_byte {
                return Ok(());
            }
            job.checkpoint(
                0.3 + 0.5 * found_end as f64 / text.len().max(1) as f64,
                "scan",
            )?;
            if options.whole_word && !whole_word(text, found_start, found_end) {
                return Ok(());
            }
            if only_range.is_some_and(|range| range != (found_start, found_end)) {
                return Ok(());
            }
            let (line, column) = if matches.len() < limit {
                source
                    .view
                    .byte_position(found_start as u64)
                    .map_err(|e| error(e.to_string()))?
            } else {
                (0, 0)
            };
            total += 1;
            if let Some(output) = output.as_mut() {
                write_bounded(output, &text.as_bytes()[last..found_start], job)?;
                if options.regex {
                    write_expansion(output, replacement.unwrap(), &captures, job)?
                } else {
                    write_bounded(output, replacement.unwrap().as_bytes(), job)?
                }
                last = found_end;
            } else if matches.len() < limit {
                let end = source
                    .view
                    .byte_position(found_end as u64)
                    .map_err(|e| error(e.to_string()))?;
                let mut end_byte = found_end.min(found_start + 4096);
                while !text.is_char_boundary(end_byte) {
                    end_byte -= 1;
                }
                matches.push(LargeFindMatch {
                    line,
                    start_column: column,
                    end_column: end.1,
                    end_line: Some(end.0),
                    preview: text[found_start..end_byte].chars().take(160).collect(),
                    text: text[found_start..end_byte].into(),
                });
            }
            Ok(())
        },
    )?;
    job.checkpoint(0.8, "candidate")?;
    if let Some(mut output) = output {
        write_bounded(&mut output, &text.as_bytes()[last..], job)?;
        output.sync_all().map_err(|e| error(e.to_string()))?;
        drop(output);
        if total == 0 {
            let receipt = super::file::retain_noop_large_job_receipt(&identity.session_id,&identity.job_id,identity.revision)?;
            return serde_json::to_value(receipt).map_err(|e| error(e.to_string()));
        }
        let snapshot = FileBaseSnapshot::create_from_stable_owned_file_with_options(
            &candidate.0,
            &source.path,
            &source.snapshot_root,
            &format!("{}-delta", identity.job_id),
            super::large_file_base::SnapshotOptions {
                cancel: Some(job.cancel.clone()),
                ..Default::default()
            },
        )
        .map_err(|e| error(e.to_string()))?;
        if let Err(e) = job.checkpoint(0.95, "commit") {
            let _ = snapshot.cleanup();
            return Err(e);
        }
        let receipt = commit_large_job(
            &identity.session_id,
            identity.revision,
            &identity.job_id,
            snapshot,
        )?;
        serde_json::to_value(receipt).map_err(|e| error(e.to_string()))
    } else {
        let result = LargeFindResult {
            truncated: total > matches.len(),
            matches,
            total,
            error: String::new(),
            revision: identity.revision,
            coordinate_space: identity.coordinate_space,
        };
        serde_json::to_value(result).map_err(|e| error(e.to_string()))
    }
}
fn whole_word(text: &str, start: usize, end: usize) -> bool {
    let word = |ch: char| ch.is_alphanumeric() || ch == '_';
    !text[..start].chars().next_back().is_some_and(word)
        && !text[end..].chars().next().is_some_and(word)
}
fn write_bounded(writer: &mut File, bytes: &[u8], job: &Job) -> Result<(), LargeFileError> {
    for chunk in bytes.chunks(64 * 1024) {
        if job.cancel.load(Ordering::Relaxed) {
            return Err(error("cancelled"));
        }
        writer.write_all(chunk).map_err(|e| error(e.to_string()))?;
    }
    Ok(())
}
fn write_expansion(
    writer: &mut File,
    replacement: &str,
    captures: &regex::Captures<'_>,
    job: &Job,
) -> Result<(), LargeFileError> {
    let mut at = 0;
    let bytes = replacement.as_bytes();
    let mut literal = 0;
    while at < bytes.len() {
        if bytes[at] != b'$' {
            at += 1;
            continue;
        }
        write_bounded(writer, &bytes[literal..at], job)?;
        at += 1;
        if bytes.get(at) == Some(&b'$') {
            write_bounded(writer, b"$", job)?;
            at += 1;
            literal = at;
            continue;
        }
        let braced = bytes.get(at) == Some(&b'{');
        if braced {
            at += 1;
        }
        let start = at;
        while at < bytes.len() && (bytes[at].is_ascii_alphanumeric() || bytes[at] == b'_') {
            at += 1;
        }
        if start == at || (braced && bytes.get(at) != Some(&b'}')) {
            write_bounded(writer, b"$", job)?;
            at = start - usize::from(braced);
            literal = at;
            continue;
        }
        let name = &replacement[start..at];
        let matched = if let Ok(index) = name.parse::<usize>() {
            captures.get(index)
        } else {
            captures.name(name)
        };
        if let Some(value) = matched {
            write_bounded(writer, value.as_str().as_bytes(), job)?
        }
        if braced {
            at += 1;
        }
        literal = at;
    }
    write_bounded(writer, &bytes[literal..], job)
}

fn visit_matches<'a>(
    regex: &regex::Regex,
    text: &'a str,
    query: &str,
    literal: bool,
    job: &Job,
    mut visit: impl FnMut(regex::Captures<'a>, usize) -> Result<(), LargeFileError>,
) -> Result<(), LargeFileError> {
    if !literal {
        job.checkpoint(0.3, "regex-scan")?;
        for captures in regex.captures_iter(text) {
            visit(captures, 0)?;
        }
        return Ok(());
    }
    let mut start = 0;
    let mut previous_end = 0;
    while start < text.len() {
        job.checkpoint(
            0.3 + 0.5 * start as f64 / text.len().max(1) as f64,
            "literal-scan",
        )?;
        let mut boundary = (start + 64 * 1024).min(text.len());
        while !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        let mut end = boundary
            .saturating_add(query.len().saturating_mul(4).saturating_add(8))
            .min(text.len());
        while !text.is_char_boundary(end) {
            end += 1;
        }
        for captures in regex.captures_iter(&text[start..end]) {
            let found = captures.get(0).unwrap();
            let from = start + found.start();
            let to = start + found.end();
            if from >= boundary {
                break;
            }
            if from < previous_end {
                continue;
            }
            previous_end = to;
            visit(captures, start)?;
        }
        start = boundary;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{
        file,
        models::{LargeCloseDisposition, TextEdit},
    };
    use super::*;
    // These cases share the production-wide four-job quota. Other unit tests
    // remain parallel; independent cases must not consume one another's slots.
    static TEST_JOB_SLOTS: Mutex<()> = Mutex::new(());
    fn fixture(name: &str, text: &str) -> (PathBuf, String) {
        let root = std::env::temp_dir().join(format!(
            "lm-large-jobs-{name}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("source.md");
        fs::write(&path, text).unwrap();
        let session = file::open_large_file_at_root(
            path.to_string_lossy().into_owned(),
            root.join("snapshots"),
        )
        .unwrap();
        (root, session.session_id)
    }
    fn options(regex: bool) -> LargeFindOptions {
        LargeFindOptions {
            regex,
            case_sensitive: true,
            whole_word: false,
        }
    }
    fn wait(job: &JobReceipt) -> JobReceipt {
        for _ in 0..2000 {
            let state = poll_large_job(
                job.job_id.clone(),
                job.session_id.clone(),
                job.revision,
                job.coordinate_space,
            )
            .unwrap();
            if state.status != "running" {
                return state;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        panic!("background job did not finish")
    }
    fn dispose(root: PathBuf, id: String, revision: u64) {
        file::close_large_file(id, revision, LargeCloseDisposition::Discard).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn expired_replace_receipts_survive_until_session_close_and_never_replay() {
        let _job_slots = TEST_JOB_SLOTS.lock().unwrap();
        let (root,id)=fixture("retained-receipt","before");
        let (other_root,other_id)=fixture("foreign-receipt","private other");
        let space=LargeCoordinateSpace::Utf16CodeUnits;
        let job=start_large_replace_job(id.clone(),0,space,"before".into(),"after".into(),options(false),None).unwrap();
        let completed=wait(&job);assert_eq!(completed.status,"completed","{:?}",completed.error);
        registry().lock().unwrap().remove(&job.job_id); // Simulate the global result TTL.
        file::apply_file_operation(id.clone(),1,space,"new-input".into(),vec![TextEdit{start_line:0,start_column:0,end_line:0,end_column:0,text:"NEW ".into()}]).unwrap();
        let receipt=poll_large_job(job.job_id.clone(),id.clone(),0,space).unwrap();
        assert_eq!((receipt.status.as_str(),receipt.kind.as_str(),receipt.revision),("completed","replace",0));
        let committed:super::super::models::LargeOperationReceipt=serde_json::from_value(receipt.result.unwrap()).unwrap();
        assert_eq!((committed.session_id.as_str(),committed.operation_id.as_str(),committed.state.revision),(id.as_str(),job.job_id.as_str(),1));
        assert_eq!(file::read_file_range(id.clone(),2,space,0,0,None,None,Some(128)).unwrap().text,"NEW after","re-poll returns evidence, never applies the old result over new input");
        assert!(poll_large_job(job.job_id.clone(),other_id.clone(),0,space).is_err(),"a different session cannot read retained receipts");
        assert!(poll_large_job(job.job_id.clone(),id.clone(),1,space).is_err(),"the original input revision is part of the receipt identity");
        assert_eq!(cancel_large_job(job.job_id.clone(),id.clone(),0,space).unwrap().status,"completed");
        let noop=start_large_replace_job(id.clone(),2,space,"absent".into(),"unused".into(),options(false),None).unwrap();
        assert_eq!(wait(&noop).status,"completed");registry().lock().unwrap().remove(&noop.job_id);
        let receipt=poll_large_job(noop.job_id.clone(),id.clone(),2,space).unwrap();
        let committed:super::super::models::LargeOperationReceipt=serde_json::from_value(receipt.result.unwrap()).unwrap();assert_eq!(committed.state.revision,2,"a no-op completion must not manufacture an edit");
        let search=start_large_search_job(id.clone(),2,space,"after".into(),options(false),None,None).unwrap();
        assert_eq!(wait(&search).status,"completed");registry().lock().unwrap().remove(&search.job_id);
        assert!(poll_large_job(search.job_id.clone(),id.clone(),2,space).is_err(),"search payloads remain reclaimable after TTL");
        dispose(root,id.clone(),2);dispose(other_root,other_id,0);
        assert!(poll_large_job(job.job_id,id,0,space).is_err(),"closing the session releases its retained small receipts");
    }
    #[test]
    fn regex_zero_width_matches_replace_and_undo_without_losing_text() {
        let _job_slots = TEST_JOB_SLOTS.lock().unwrap();
        let original = "\u{feff}first\r\nsecond\nthird";
        let (root, id) = fixture("zero-width", original);
        let space = LargeCoordinateSpace::Utf16CodeUnits;
        let search = start_large_search_job(id.clone(), 0, space, "^".into(), options(true), Some(1), Some(1)).unwrap();
        let result = wait(&search);
        assert_eq!(result.status, "completed", "{:?}", result.error);
        let found: LargeFindResult = serde_json::from_value(result.result.unwrap()).unwrap();
        assert_eq!(found.total, 2);
        assert_eq!(found.matches.len(), 1);
        assert_eq!((found.matches[0].line, found.matches[0].start_column, found.matches[0].end_column), (1, 0, 0));
        let replace = start_large_replace_job(id.clone(), 0, space, "^".into(), "> ".into(), options(true), None).unwrap();
        let result = wait(&replace);
        assert_eq!(result.status, "completed", "{:?}", result.error);
        let source = capture_large_job(&id, 1, false).unwrap();
        let mut output = Vec::new();
        source.view.write_to(&mut output).unwrap();
        assert_eq!(String::from_utf8(output).unwrap(), "\u{feff}> first\r\n> second\n> third");
        drop(source);
        file::move_large_history(id.clone(), 1, space, "undo".into(), "undo-zero-width".into()).unwrap();
        let source = capture_large_job(&id, 2, false).unwrap();
        let mut output = Vec::new();
        source.view.write_to(&mut output).unwrap();
        assert_eq!(String::from_utf8(output).unwrap(), original);
        drop(source);
        dispose(root, id, 2);
    }
    #[test]
    fn replacement_can_insert_a_leading_bom_without_losing_bytes() {
        let _job_slots = TEST_JOB_SLOTS.lock().unwrap();
        let (root, id) = fixture("insert-bom", "plain text");
        let space = LargeCoordinateSpace::Utf16CodeUnits;
        let job = start_large_replace_job(id.clone(), 0, space, "^".into(), "\u{feff}".into(), options(true), None).unwrap();
        let completed = wait(&job);
        assert_eq!(completed.status, "completed", "{:?}", completed.error);
        let source = capture_large_job(&id, 1, false).unwrap();
        let mut output = Vec::new();
        source.view.write_to(&mut output).unwrap();
        assert_eq!(String::from_utf8(output).unwrap(), "\u{feff}plain text");
        drop(source);
        dispose(root, id, 1);
    }
    #[test]
    fn chunk_boundary_literal_regex_capture_replace_undo_and_cleanup() {
        let _job_slots = TEST_JOB_SLOTS.lock().unwrap();
        let original = format!(
            "\u{feff}{}HELLO😀\r\nother HELLO😀",
            "x".repeat(64 * 1024 - 3)
        );
        let (root, id) = fixture("replace", &original);
        let space = LargeCoordinateSpace::Utf16CodeUnits;
        let search = start_large_search_job(
            id.clone(),
            0,
            space,
            "HELLO😀".into(),
            options(false),
            None,
            Some(10),
        )
        .unwrap();
        let result = wait(&search);
        assert_eq!(result.status, "completed", "{:?}", result.error);
        let found: LargeFindResult = serde_json::from_value(result.result.unwrap()).unwrap();
        assert_eq!(found.total, 2);
        assert_eq!(found.matches[0].start_column, 64 * 1024 - 3);
        let replace = start_large_replace_job(
            id.clone(),
            0,
            space,
            "(HELLO)(😀)".into(),
            "${2}-$1-$$".into(),
            options(true),
            None,
        )
        .unwrap();
        let result = wait(&replace);
        assert_eq!(result.status, "completed", "{:?}", result.error);
        let changed = file::read_file_range(
            id.clone(),
            1,
            space,
            0,
            64 * 1024 - 3,
            None,
            None,
            Some(128),
        )
        .unwrap();
        assert_eq!(changed.text, "😀-HELLO-$\r\nother 😀-HELLO-$");
        file::save_large_file(id.clone(), 1, space).unwrap();
        let disk = fs::read_to_string(root.join("source.md")).unwrap();
        assert!(disk.starts_with('\u{feff}'));
        assert!(disk.ends_with("other 😀-HELLO-$"));
        file::move_large_history(id.clone(), 1, space, "undo".into(), "undo".into()).unwrap();
        assert_eq!(
            file::read_file_range(id.clone(), 2, space, 0, 0, None, None, None)
                .unwrap()
                .text,
            &original[3..]
        );
        file::move_large_history(id.clone(), 2, space, "redo".into(), "redo".into()).unwrap();
        dispose(root, id, 3);
    }
    #[test]
    fn cancelled_and_stale_candidates_never_publish_and_leave_no_temp_delta() {
        let (root, id) = fixture("cancel-stale", "before before");
        let source = capture_large_job(&id, 0, true).unwrap();
        let space = LargeCoordinateSpace::Utf16CodeUnits;
        let identity = JobReceipt {
            job_id: "cancel-test".into(),
            session_id: id.clone(),
            revision: 0,
            coordinate_space: space,
            kind: "replace".into(),
            status: "running".into(),
            progress: 0.,
            phase: "snapshot".into(),
            result: None,
            error: None,
        };
        let job = Job {
            state: Mutex::new(identity.clone()),
            cancel: Arc::new(AtomicBool::new(true)),
            finished_at: AtomicU64::new(0),
        };
        assert!(run(
            &job,
            &identity,
            &source,
            "before",
            &options(false),
            Some("after"),
            None,
            0,
            0
        )
        .is_err());
        job.cancel.store(false, Ordering::Relaxed);
        file::apply_file_edits(
            id.clone(),
            vec![TextEdit {
                start_line: 0,
                start_column: 0,
                end_line: 0,
                end_column: 0,
                text: "NEW ".into(),
            }],
            0,
            space,
        )
        .unwrap();
        let error = run(
            &job,
            &identity,
            &source,
            "before",
            &options(false),
            Some("after"),
            None,
            0,
            0,
        )
        .unwrap_err();
        assert_eq!(error.code, "stale-revision");
        assert_eq!(
            file::read_file_range(id.clone(), 1, space, 0, 0, None, None, None)
                .unwrap()
                .text,
            "NEW before before"
        );
        assert!(!source.snapshot_root.join("cancel-test-delta").exists());
        assert!(!source.snapshot_root.join("cancel-test-input.tmp").exists());
        assert!(!source
            .snapshot_root
            .join("cancel-test-candidate.tmp")
            .exists());
        drop(source);
        dispose(root, id, 1);
    }
    #[test]
    fn current_match_coordinates_replace_complete_long_capture() {
        let _job_slots = TEST_JOB_SLOTS.lock().unwrap();
        let original = format!("{}TAIL\nkeep", "a".repeat(160 * 1024));
        let (root, id) = fixture("long-capture", &original);
        let space = LargeCoordinateSpace::Utf16CodeUnits;
        let found = wait(
            &start_large_search_job(
                id.clone(),
                0,
                space,
                "a+TAIL".into(),
                options(true),
                None,
                Some(10),
            )
            .unwrap(),
        );
        let result: LargeFindResult = serde_json::from_value(found.result.unwrap()).unwrap();
        assert_eq!(result.matches[0].text.len(), 4096);
        let current = result.matches.into_iter().next().unwrap();
        let replaced = wait(
            &start_large_replace_job(
                id.clone(),
                0,
                space,
                "(a+)TAIL".into(),
                "[$1]".into(),
                options(true),
                Some(current),
            )
            .unwrap(),
        );
        assert_eq!(replaced.status, "completed", "{:?}", replaced.error);
        let tail = file::read_file_range(id.clone(), 1, space, 0, 160 * 1024, None, None, Some(32))
            .unwrap();
        assert_eq!(tail.text, "a]\nkeep");
        dispose(root, id, 1);
    }

    #[test]
    #[ignore = "explicit physical 50/100/500MiB disk acceptance; writes several GiB"]
    fn physical_large_file_matrix() {
        let _job_slots = TEST_JOB_SLOTS.lock().unwrap();
        use std::io::{Seek, SeekFrom};
        use std::time::Instant;
        for (mib, short_lines) in [(50_u64, true), (100, false), (500, false)] {
            let started = Instant::now();
            let root = std::env::temp_dir().join(format!(
                "lm-physical-{mib}-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&root).unwrap();
            let path = root.join("source.md");
            let size = mib * 1024 * 1024;
            let block = if short_lines {
                b"x\n".repeat(32 * 1024)
            } else {
                vec![b'x'; 64 * 1024]
            };
            let mut output = File::create(&path).unwrap();
            for _ in 0..size / (64 * 1024) {
                output.write_all(&block).unwrap();
            }
            output.seek(SeekFrom::End(-6)).unwrap();
            output.write_all(b"NEEDLE").unwrap();
            output.sync_all().unwrap();
            drop(output);
            let opened = file::open_large_file_at_root(
                path.to_string_lossy().into_owned(),
                root.join("snapshots"),
            )
            .unwrap();
            let id = opened.session_id.clone();
            let space = LargeCoordinateSpace::Utf16CodeUnits;
            let opened_ms = started.elapsed().as_millis();
            assert_eq!(opened.size_bytes, size);
            let captured = capture_large_job(&id, 0, false).unwrap();
            assert!(captured.view.read_chunk(0, opened.total_lines).is_err());
            drop(captured);
            let (line, col) = if short_lines {
                (opened.total_lines - 1, 0)
            } else {
                (0, size as usize - 6)
            };
            assert_eq!(
                file::read_file_range(id.clone(), 0, space, line, col, None, None, Some(64))
                    .unwrap()
                    .text,
                "NEEDLE"
            );
            let edited_text=if mib==500 { "EDITED!" } else { "EDITED" };
            file::apply_file_operation(
                id.clone(),
                0,
                space,
                "physical-edit".into(),
                vec![TextEdit {
                    start_line: line,
                    start_column: col,
                    end_line: line,
                    end_column: col + 6,
                    text: edited_text.into(),
                }],
            )
            .unwrap();
            assert_eq!(
                file::read_file_range(id.clone(), 1, space, line, col, None, None, Some(64))
                    .unwrap()
                    .text,
                edited_text
            );
            file::save_large_file(id.clone(), 1, space).unwrap();
            let saved_ms = started.elapsed().as_millis();
            if mib==500 {
                let oversized=file::open_large_file_at_root(path.to_string_lossy().into_owned(),root.join("snapshots")).unwrap();
                assert_eq!(oversized.size_bytes,size+1);
                let blocked=file::apply_file_operation(oversized.session_id.clone(),0,space,"read-only-open".into(),vec![TextEdit{start_line:0,start_column:0,end_line:0,end_column:0,text:"X".into()}]).unwrap_err();
                assert_eq!(blocked.code,"large-file-read-only");
                file::close_large_file(oversized.session_id,0,LargeCloseDisposition::Saved).unwrap();
            }

            let search = start_large_search_job(
                id.clone(),
                1,
                space,
                "EDITED".into(),
                options(false),
                None,
                Some(10),
            )
            .unwrap();
            let completed = wait_stress(&search);
            assert_eq!(completed.status, "completed", "{:?}", completed.error);
            let found: LargeFindResult = serde_json::from_value(completed.result.unwrap()).unwrap();
            assert_eq!(found.total, 1);
            let replace = start_large_replace_job(
                id.clone(),
                1,
                space,
                "EDITED".into(),
                "FINAL!".into(),
                options(false),
                None,
            )
            .unwrap();
            let completed = wait_stress(&replace);
            assert_eq!(completed.status, "completed", "{:?}", completed.error);
            file::move_large_history(
                id.clone(),
                2,
                space,
                "undo".into(),
                "physical-undo-replace".into(),
            )
            .unwrap();
            assert_eq!(
                file::read_file_range(id.clone(), 3, space, line, col, None, None, Some(64))
                    .unwrap()
                    .text,
                edited_text
            );
            file::move_large_history(
                id.clone(),
                3,
                space,
                "undo".into(),
                "physical-undo-input".into(),
            )
            .unwrap();
            assert_eq!(
                file::read_file_range(id.clone(), 4, space, line, col, None, None, Some(64))
                    .unwrap()
                    .text,
                "NEEDLE"
            );
            file::save_large_file(id.clone(), 4, space).unwrap();
            file::close_large_file(id, 4, LargeCloseDisposition::Saved).unwrap();
            let reopened = file::open_large_file_at_root(
                path.to_string_lossy().into_owned(),
                root.join("snapshots"),
            )
            .unwrap();
            assert_eq!(reopened.size_bytes, size);
            assert_eq!(
                file::read_file_range(
                    reopened.session_id.clone(),
                    0,
                    space,
                    line,
                    col,
                    None,
                    None,
                    Some(64)
                )
                .unwrap()
                .text,
                "NEEDLE"
            );
            file::close_large_file(reopened.session_id, 0, LargeCloseDisposition::Saved).unwrap();
            let report = serde_json::json!({"mib":mib,"shortLines":short_lines,"bytes":size,"lines":opened.total_lines,"openMs":opened_ms,"firstSaveMs":saved_ms,"totalMs":started.elapsed().as_millis(),"result":"passed","growthAndReadOnlyBoundaryChecked":mib==500});
            println!("{report}");
            fs::remove_dir_all(root).unwrap();
        }
    }
    fn wait_stress(job: &JobReceipt) -> JobReceipt {
        for _ in 0..24_000 {
            let state = poll_large_job(
                job.job_id.clone(),
                job.session_id.clone(),
                job.revision,
                job.coordinate_space,
            )
            .unwrap();
            if state.status != "running" {
                return state;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("physical background job did not finish")
    }
}
