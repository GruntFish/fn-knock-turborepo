//! Synchronous, bounded SCM logging: process::exit must not discard the last error.
use super::{GATEWAY_CONSOLE_LOG_MAX_BYTES, RotatingFile, WindowsPaths};
use crate::storage::startup_diagnostics::sanitize_diagnostic;
use std::{
    io::{self, Write},
    sync::{Mutex, OnceLock},
};
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

static LOG: OnceLock<Mutex<RotatingFile>> = OnceLock::new();
static LOG_ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn remember_error(error: impl std::fmt::Display) {
    if let Ok(mut current) = LOG_ERROR.get_or_init(|| Mutex::new(None)).lock() {
        *current = Some(sanitize_diagnostic(&format!(
            "service log unavailable: {error}"
        )));
    }
}

pub(super) fn error() -> Option<String> {
    LOG_ERROR
        .get()
        .and_then(|state| state.lock().ok())
        .and_then(|state| state.clone())
}

pub(super) fn init() {
    let result = (|| -> anyhow::Result<()> {
        let paths = WindowsPaths::discover()?;
        // An inaccessible business-data directory must not suppress its own diagnostics.
        std::fs::create_dir_all(&paths.logs)?;
        let writer = RotatingFile::new(
            paths.logs.join("service.log"),
            GATEWAY_CONSOLE_LOG_MAX_BYTES,
        )?;
        let _ = LOG.set(Mutex::new(writer));
        Ok(())
    })();
    if let Err(error) = result {
        remember_error(error);
    }
    if let Err(error) =
        tracing_subscriber::registry()
            .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                EnvFilter::new("server_admin_rs=info,tower_http=info,axum=info")
            }))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(|| Record(Vec::new())),
            )
            .try_init()
    {
        remember_error(error);
    }
}

struct Record(Vec<u8>);
impl Write for Record {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        // The writer must report the complete input as consumed even when capped.
        let retain = bytes.len().min(32768usize.saturating_sub(self.0.len()));
        self.0.extend_from_slice(&bytes[..retain]);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Drop for Record {
    fn drop(&mut self) {
        if self.0.is_empty() {
            return;
        }
        append(&String::from_utf8_lossy(&self.0));
    }
}

pub(super) fn append(message: &str) {
    if let Some(writer) = LOG.get() {
        let result = (|| -> io::Result<()> {
            let mut writer = writer
                .lock()
                .map_err(|_| io::Error::other("service log lock poisoned"))?;
            writer.write(format!("{}\n", sanitize_diagnostic(message)).as_bytes())?;
            writer.flush()
        })();
        if let Err(error) = result {
            remember_error(error);
        }
    }
}
