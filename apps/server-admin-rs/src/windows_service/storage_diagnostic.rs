use super::*;
use crate::storage::offline_diagnostic::{CopyReport, inspect_copy};
use anyhow::{Context, bail};
use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    io,
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

#[derive(Serialize)]
struct Report {
    schema_version: u32,
    version: &'static str,
    running_identity: Option<String>,
    service_identity_verified: bool,
    note: &'static str,
    source_files: Vec<SourceFile>,
    result: Option<CopyReport>,
    prerequisite_error: Option<String>,
}
#[derive(Serialize)]
struct SourceFile {
    role: &'static str,
    exists: bool,
    bytes: Option<u64>,
    readonly: Option<bool>,
    windows_attributes: Option<u32>,
}

fn arguments() -> anyhow::Result<(Option<PathBuf>, bool)> {
    let mut arguments = env::args_os().skip(2);
    let mut database = None;
    let mut json = false;
    while let Some(argument) = arguments.next() {
        if argument == "--json" && !json {
            json = true;
        } else if argument == "--database" && database.is_none() {
            let path = arguments.next().context("--database requires a path")?;
            if path.is_empty() || path.to_string_lossy().starts_with("--") {
                bail!("--database requires a path");
            }
            database = Some(PathBuf::from(path));
        } else {
            bail!("usage: diagnose-storage [--database <path>] [--json]");
        }
    }
    Ok((database, json))
}

pub(super) fn command() -> anyhow::Result<()> {
    let mut report = Report {
        schema_version: 1,
        version: APP_LOCAL_VERSION,
        running_identity: None,
        service_identity_verified: false,
        note: "Checks run on a disposable copy as the reported caller; success does not verify NT SERVICE\\FnKnock access. The original database is never opened by SQLite.",
        source_files: Vec::new(),
        result: None,
        prerequisite_error: None,
    };
    let mut json = env::args_os().any(|argument| argument == "--json");
    let outcome = (|| -> anyhow::Result<()> {
        let (database, requested_json) = arguments()?;
        json = requested_json;
        report.running_identity = Some(
            crate::infra::private_permissions::current_windows_sid(&trusted_system_directory()?)
                .map_err(anyhow::Error::msg)?,
        );
        let default = WindowsPaths::discover()?
            .data
            .join("storage/fn-knock.sqlite3");
        let database = database.unwrap_or_else(|| default.clone());
        reject_reparse(&database)?;
        let database = database
            .canonicalize()
            .context("database must already exist")?;
        if default.canonicalize().ok().as_ref() == Some(&database) {
            require_stopped_service()?;
        }
        let mut files = Vec::new();
        for (role, suffix) in [("database", ""), ("wal", "-wal"), ("journal", "-journal")] {
            let mut name = database.as_os_str().to_os_string();
            name.push(suffix);
            let path = PathBuf::from(name);
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound && !suffix.is_empty() => {
                    report.source_files.push(SourceFile {
                        role,
                        exists: false,
                        bytes: None,
                        readonly: None,
                        windows_attributes: None,
                    });
                    continue;
                }
                Err(error) => return Err(error).context("inspect source file"),
            };
            if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 {
                bail!("source must be an ordinary file without reparse points");
            }
            // FILE_SHARE_READ only: fail if any writer/delete handle already exists,
            // and keep new SQLite writers out until every source has been copied.
            let file = OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(&path)
                .context("cannot lock source for safe copying; stop all database writers first")?;
            let metadata = file.metadata()?;
            report.source_files.push(SourceFile {
                role,
                exists: true,
                bytes: Some(metadata.len()),
                readonly: Some(metadata.permissions().readonly()),
                windows_attributes: Some(metadata.file_attributes()),
            });
            files.push((suffix, file, metadata.len()));
        }
        let temporary = tempfile::Builder::new()
            .prefix("fn-knock-storage-diagnostic-")
            .tempdir()?;
        crate::infra::private_permissions::secure_windows_path(temporary.path(), true)
            .map_err(anyhow::Error::msg)?;
        let copy = temporary.path().join("diagnostic.sqlite3");
        for (suffix, source, expected) in &mut files {
            let mut path = copy.as_os_str().to_os_string();
            path.push(suffix);
            let mut destination = File::create(PathBuf::from(path))?;
            if io::copy(source, &mut destination)? != *expected
                || source.metadata()?.len() != *expected
            {
                bail!("source changed while copying; no diagnostic was run");
            }
            destination.sync_all()?;
        }
        // A writer cannot create a new WAL/journal through SQLite while the main
        // database is held without write sharing. Check external interference too.
        for source in report.source_files.iter().filter(|file| !file.exists) {
            let suffix = if source.role == "wal" {
                "-wal"
            } else {
                "-journal"
            };
            let mut path = database.as_os_str().to_os_string();
            path.push(suffix);
            if Path::new(&path).try_exists()? {
                bail!("source companion appeared while copying");
            }
        }
        drop(files);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        report.result = Some(runtime.block_on(inspect_copy(&copy)));
        drop(runtime);
        // SQLite worker threads close asynchronously after Store is dropped.
        // Retry cleanup briefly, and report failure rather than silently retaining data.
        let temporary_path = temporary.keep();
        for attempt in 0..20 {
            match std::fs::remove_dir_all(&temporary_path) {
                Ok(()) => return Ok(()),
                Err(_) if attempt < 19 => std::thread::sleep(Duration::from_millis(50)),
                Err(error) => return Err(error).context("diagnostic copy cleanup failed"),
            }
        }
        unreachable!()
    })();
    let code = if let Err(error) = outcome {
        report.prerequisite_error = Some(sanitize_diagnostic(&format!("{error:#}")));
        2
    } else if report.result.as_ref().is_some_and(|result| {
        result.initialization_passed && result.migration_inspection_failure.is_none()
    }) {
        0
    } else {
        1
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("{}", report.note);
        println!("{}", serde_json::to_string_pretty(&report)?);
    }
    // All temporary files/handles and the runtime have been dropped before exit.
    std::process::exit(code);
}

fn require_stopped_service() -> anyhow::Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    match manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
        Ok(service) if service.query_status()?.current_state != ServiceState::Stopped => {
            bail!("stop the FnKnock service before diagnosing its database")
        }
        Ok(_) => Ok(()),
        Err(windows_service::Error::Winapi(error)) if error.raw_os_error() == Some(1060) => Ok(()),
        Err(error) => Err(error).context("query service state before copying"),
    }
}

fn reject_reparse(path: &Path) -> anyhow::Result<()> {
    let path = std::path::absolute(path)?;
    for ancestor in path.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor)?;
        if metadata.file_attributes() & 0x400 != 0 {
            bail!("diagnostic source cannot traverse a reparse point");
        }
    }
    Ok(())
}
