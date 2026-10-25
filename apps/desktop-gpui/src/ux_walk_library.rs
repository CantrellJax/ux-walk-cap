use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WalkStatus {
    Recording,
    Saved,
    Processing,
    Ready,
    Failed(String),
    Interrupted,
}

impl WalkStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Recording => "Recording",
            Self::Saved => "Notes saved",
            Self::Processing => "Processing",
            Self::Ready => "Ready",
            Self::Failed(_) => "Processing needs attention",
            Self::Interrupted => "Interrupted · notes saved",
        }
    }

    pub fn notice(&self) -> String {
        match self {
            Self::Recording => "Recording and notes are being saved.".into(),
            Self::Saved => {
                "Recording and notes are saved. A processed report is not available yet.".into()
            }
            Self::Processing => {
                "Preparing chapters, screenshots and transcript… Your notes are available below."
                    .into()
            }
            Self::Ready => "Walk ready. Read the report or copy a prompt for your agent.".into(),
            Self::Failed(error) => {
                format!("Recording and notes are saved. Processing needs attention: {error}")
            }
            Self::Interrupted => {
                "This walk was interrupted. Its saved notes remain available.".into()
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalkSummary {
    pub file: PathBuf,
    pub directory: PathBuf,
    pub source_project: PathBuf,
    pub topic: String,
    pub started_at_ms: u64,
    pub status: WalkStatus,
}

#[derive(Default)]
pub struct WalkSelection {
    pub file: Option<PathBuf>,
    revision: u64,
}

impl WalkSelection {
    pub fn choose(&mut self, file: Option<PathBuf>) -> u64 {
        self.revision = self.revision.wrapping_add(1);
        self.file = file;
        self.revision
    }

    pub fn accepts(&self, file: &Path, revision: u64) -> bool {
        self.revision == revision && self.file.as_deref() == Some(file)
    }
}

impl WalkSummary {
    pub fn report_ready(&self) -> bool {
        self.status == WalkStatus::Ready
    }

    pub fn is_active(&self) -> bool {
        matches!(self.status, WalkStatus::Recording | WalkStatus::Processing)
    }
}

fn expanded_path(text: &str) -> PathBuf {
    if text == "~" || text.starts_with("~/") {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        return text
            .strip_prefix("~/")
            .map_or(home.clone(), |tail| home.join(tail));
    }
    PathBuf::from(text)
}

pub fn read_walk(file: &Path) -> Result<(WalkSummary, crate::ux_walk_journal::Journal), String> {
    let file = file
        .canonicalize()
        .map_err(|_| "This walk’s notes could not be found.")?;
    if file
        .file_name()
        .is_none_or(|name| name != "native-walk.json")
    {
        return Err("This is not a native UX Walk journal.".into());
    }
    let journal: crate::ux_walk_journal::Journal =
        serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
            .map_err(|_| "This walk’s notes have an invalid format.")?;
    if journal.schema_version != 1 {
        return Err("This walk’s notes use an unsupported format.".into());
    }
    let directory = file.parent().ok_or("Invalid walk folder.")?.to_path_buf();
    if journal.request.directory.canonicalize().ok().as_ref() != Some(&directory) {
        return Err("This walk’s notes belong to another folder.".into());
    }
    if !journal.source_project.is_absolute() || journal.request.topic.trim().is_empty() {
        return Err("This walk’s source recording or topic is missing.".into());
    }
    let status = match journal.state.as_str() {
        "recording" => WalkStatus::Recording,
        "aborted" => WalkStatus::Interrupted,
        "complete" => processing_status(&directory),
        _ => return Err("Invalid walk state.".into()),
    };
    let summary = WalkSummary {
        file,
        directory,
        source_project: journal.source_project.clone(),
        topic: journal.request.topic.clone(),
        started_at_ms: journal.started_at_ms,
        status,
    };
    Ok((summary, journal))
}

pub fn read_summary(file: &Path) -> Result<WalkSummary, String> {
    read_walk(file).map(|(summary, _)| summary)
}

pub fn processing_status(directory: &Path) -> WalkStatus {
    let file = directory.join("processing.json");
    let state = fs::read(&file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    if file.exists() && state.is_none() {
        return WalkStatus::Failed("The processing status could not be read.".into());
    }
    match state.as_ref().and_then(|state| state["state"].as_str()) {
        Some("processing") => WalkStatus::Processing,
        Some("failed") => WalkStatus::Failed(
            state
                .as_ref()
                .and_then(|state| state["error"].as_str())
                .unwrap_or("Try processing this walk again.")
                .to_string(),
        ),
        Some("ready") if directory.join("report.html").is_file() => WalkStatus::Ready,
        Some("ready") => WalkStatus::Failed("The report is missing. Reprocess this walk.".into()),
        _ if directory.join(".processing-lock").is_dir() => WalkStatus::Processing,
        _ if directory.join("report.html").is_file() && state.is_none() => WalkStatus::Ready,
        _ => WalkStatus::Saved,
    }
}

pub fn evidence_notice(directory: &Path) -> String {
    let session = fs::read(directory.join("session.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    if let Some(coverage) = session
        .as_ref()
        .and_then(|value| value["coverage"].as_object())
    {
        return [
            ("dom", "Clicks and page details"),
            ("network", "Requests"),
            ("console", "Console"),
        ]
        .into_iter()
        .map(|(key, label)| {
            let value = coverage
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("not captured");
            format!("{label}: {}", value.chars().take(240).collect::<String>())
        })
        .collect::<Vec<_>>()
        .join(" · ");
    }
    "Copy an agent prompt to review the browser evidence available for this walk.".into()
}

pub fn index_in(roots: &[PathBuf], explicit_files: &[PathBuf]) -> BTreeMap<PathBuf, WalkSummary> {
    let mut files: BTreeSet<PathBuf> = explicit_files.iter().cloned().collect();
    for root in roots {
        if let Ok(entries) = fs::read_dir(root) {
            files.extend(
                entries
                    .flatten()
                    .map(|entry| entry.path().join("native-walk.json")),
            );
        }
    }
    let mut seen = BTreeSet::new();
    let mut walks: Vec<_> = files
        .into_iter()
        .filter_map(|file| read_summary(&file).ok())
        .filter(|walk| seen.insert(walk.file.clone()))
        .collect();
    // Several journals can reference one project; the newest start wins, with a stable path tie-break.
    walks.sort_by(|a, b| (a.started_at_ms, &a.file).cmp(&(b.started_at_ms, &b.file)));
    let mut index = BTreeMap::new();
    for mut walk in walks {
        if let Ok(source) = walk.source_project.canonicalize() {
            walk.source_project = source.clone();
            index.insert(source, walk);
        }
    }
    index
}

pub fn index() -> BTreeMap<PathBuf, WalkSummary> {
    if !cfg!(all(target_os = "macos", feature = "ux-walk")) {
        return BTreeMap::new();
    }
    let settings = crate::ux_walk::load().unwrap_or_default();
    let section = crate::store::store_section(crate::store::RECORDING_SETTINGS);
    let mut roots = vec![expanded_path(crate::ux_walk::text(&settings, "outDir"))];
    roots.extend(
        section
            .get("nativeWalkRoots")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(PathBuf::from),
    );
    let mut files: Vec<_> = section
        .get("nativeWalks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(PathBuf::from)
        .collect();
    if let Some(file) = section
        .get("lastNativeWalk")
        .and_then(Value::as_str)
        .map(PathBuf::from)
    {
        if let Some(root) = file.parent().and_then(Path::parent) {
            roots.push(root.to_path_buf());
        }
        files.push(file);
    }
    index_in(&roots, &files)
}

fn append_path(section: &mut Map<String, Value>, key: &str, path: &Path) {
    let values = section
        .entry(key.to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !values.is_array() {
        *values = Value::Array(Vec::new());
    }
    let values = values.as_array_mut().expect("array replaced above");
    let value = Value::String(path.to_string_lossy().into_owned());
    if !values.contains(&value) {
        values.push(value);
    }
}

pub fn remember_journal(file: &Path) -> Result<(), String> {
    let file = file.canonicalize().map_err(|e| e.to_string())?;
    if crate::store::update_store_section(crate::store::RECORDING_SETTINGS, |section| {
        append_path(section, "nativeWalks", &file);
        true
    }) {
        Ok(())
    } else {
        Err(
            "Could not remember this walk in the library. Its recording and notes are still saved."
                .into(),
        )
    }
}

pub fn remember_root(path: &str) -> Result<(), String> {
    let path = expanded_path(path);
    let path = path.canonicalize().unwrap_or(path);
    if crate::store::update_store_section(crate::store::RECORDING_SETTINGS, |section| {
        append_path(section, "nativeWalkRoots", &path);
        true
    }) {
        Ok(())
    } else {
        Err("Could not remember the previous walk recordings folder.".into())
    }
}
