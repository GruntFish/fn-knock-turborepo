//! Startup diagnostics retain typed causes, but never emit database values.
use std::sync::LazyLock;

use serde::Serialize;
use tokio_rusqlite::rusqlite::{Error as SqliteError, ErrorCode};

use super::StorageError;

#[derive(Debug, Serialize)]
pub(crate) struct StorageFailure {
    pub stage: Option<&'static str>,
    pub code: String,
    pub retryable: bool,
    pub message: String,
}

/// Used by both the SCM host and the offline diagnostic command.
impl StorageFailure {
    pub(crate) fn from_error(error: &StorageError) -> Self {
        let mut leaf = error;
        let mut stages = Vec::new();
        while let StorageError::Initialization { stage, source } = leaf {
            stages.push(*stage);
            leaf = source;
        }
        let (code, retryable, detail) = match leaf {
            StorageError::Migration(message) => {
                ("migration_incompatible".into(), false, message.clone())
            }
            StorageError::InvalidConfiguration(message) => {
                ("invalid_configuration".into(), false, message.clone())
            }
            // serde messages may embed unexpected user-controlled values. Location is sufficient.
            StorageError::SerdeJson(error) => (
                "invalid_json".into(),
                false,
                format!(
                    "invalid stored JSON at line {}, column {} ({:?})",
                    error.line(),
                    error.column(),
                    error.classify()
                ),
            ),
            StorageError::Io(error) => (
                format!(
                    "io:{:?}:{}",
                    error.kind(),
                    error
                        .raw_os_error()
                        .map(|code| code.to_string())
                        .unwrap_or_default()
                ),
                matches!(error.raw_os_error(), Some(32 | 33))
                    || error.kind() != std::io::ErrorKind::PermissionDenied,
                error.to_string(),
            ),
            StorageError::Sqlite(SqliteError::SqliteFailure(code, message))
            | StorageError::SqliteClose(SqliteError::SqliteFailure(code, message)) => (
                format!("sqlite:{:?}:{}", code.code, code.extended_code),
                !matches!(
                    code.code,
                    ErrorCode::PermissionDenied
                        | ErrorCode::ReadOnly
                        | ErrorCode::DatabaseCorrupt
                        | ErrorCode::NotADatabase
                        | ErrorCode::ConstraintViolation
                        | ErrorCode::TypeMismatch
                ),
                // SQLite messages can include trigger text, identifiers or database values.
                // Keep the engine's code description and a known category, never arbitrary text.
                format!("{}{}", code, sqlite_message_category(message.as_deref())),
            ),
            // Other rusqlite variants can contain SQL or data. Preserve their type without values.
            StorageError::Sqlite(_) | StorageError::SqliteClose(_) => (
                "sqlite_api_error".into(),
                false,
                "SQLite schema or value conversion failed".into(),
            ),
            StorageError::SqliteConnectionClosed => (
                "sqlite_worker_closed".into(),
                true,
                "SQLite worker closed".into(),
            ),
            StorageError::Message(message) => ("storage_error".into(), true, message.clone()),
            StorageError::Initialization { .. } => unreachable!(),
        };
        let message = if stages.is_empty() {
            detail
        } else {
            format!("{}: {detail}", stages.join(": "))
        };
        Self {
            stage: stages.last().copied(),
            code,
            retryable,
            message: sanitize_diagnostic(&message),
        }
    }
}

fn sqlite_message_category(message: Option<&str>) -> &'static str {
    match message {
        Some(message) if message.starts_with("no such table:") => ": required table is missing",
        Some(message) if message.starts_with("no such column:") => ": required column is missing",
        Some(message) if message.starts_with("malformed database schema") => {
            ": malformed database schema"
        }
        _ => "",
    }
}

#[cfg(any(windows, test))]
pub(crate) fn error_detail(error: &anyhow::Error) -> String {
    if let Some(storage) = error.downcast_ref::<StorageError>() {
        let detail = StorageFailure::from_error(storage);
        let context = error
            .chain()
            .take_while(|cause| cause.downcast_ref::<StorageError>().is_none())
            .map(|cause| sanitize_diagnostic(&cause.to_string()))
            .collect::<Vec<_>>();
        let prefix = if context.is_empty() {
            String::new()
        } else {
            format!("{}: ", context.join(": "))
        };
        format!("{prefix}{} [{}]", detail.message, detail.code)
    } else if let Some(json) = error.downcast_ref::<serde_json::Error>() {
        let context = error
            .chain()
            .take_while(|cause| cause.downcast_ref::<serde_json::Error>().is_none())
            .map(|cause| sanitize_diagnostic(&cause.to_string()))
            .collect::<Vec<_>>();
        format!(
            "{}: invalid JSON at line {}, column {} ({:?})",
            context.join(": "),
            json.line(),
            json.column(),
            json.classify()
        )
    } else {
        sanitize_diagnostic(&format!("{error:#}"))
    }
}

/// Preserve technical context while removing common secret assignments, quoted
/// payloads, URLs and absolute paths. No raw environment or config is logged.
pub(crate) fn sanitize_diagnostic(message: &str) -> String {
    static SECRETS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r#"(?i)(authorization|cookie|password|passwd|secret|token|private_key)["']?\s*[:=]\s*(?:bearer\s+[^\s,;]+|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)|bearer\s+[^\s]+|-----BEGIN[\s\S]*"#
    ).unwrap()
    });
    static URLS_PATHS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r#"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s]+|[A-Za-z]:\\[^\r\n,;]*|/(?:Users|home|tmp|var)/[^\s]+"#
    ).unwrap()
    });
    let sanitized = SECRETS.replace_all(message, "[redacted]");
    let sanitized = URLS_PATHS.replace_all(&sanitized, "[path]");
    sanitized
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(8192)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::StorageResultExt;

    #[test]
    fn stages_preserve_sqlite_extended_code_and_retry_policy() {
        for (raw, retryable) in [
            (5, true),
            (6, true),
            (10, true),
            (11, false),
            (26, false),
            (8, false),
            (19, false),
        ] {
            let error = Err::<(), _>(SqliteError::SqliteFailure(
                tokio_rusqlite::rusqlite::ffi::Error::new(raw),
                None,
            ))
            .storage_stage("connection.wal")
            .storage_stage("storage.connect")
            .unwrap_err();
            let report = StorageFailure::from_error(&error);
            assert_eq!(report.stage, Some("connection.wal"));
            assert_eq!(report.retryable, retryable);
            assert!(report.code.ends_with(&format!(":{raw}")));
        }
    }

    #[test]
    fn stored_json_values_and_secrets_are_not_reported() {
        let json_error = serde_json::from_str::<u64>(r#""private-value""#).unwrap_err();
        let report = StorageFailure::from_error(&StorageError::SerdeJson(json_error));
        assert!(!report.message.contains("private-value"));
        assert!(!report.retryable);
        let text = sanitize_diagnostic(
            "failure password=abc token='def' https://secret.example/path C:\\private\\db",
        );
        for secret in ["abc", "def", "secret.example", "private\\db"] {
            assert!(!text.contains(secret));
        }
        for message in [
            r#"authorization=Bearer hiddencredential"#,
            r#"password="abc\"hiddencredential""#,
        ] {
            assert!(!sanitize_diagnostic(message).contains("hiddencredential"));
        }
        let json_error = serde_json::from_str::<u64>(r#""private-value""#).unwrap_err();
        let detail = error_detail(&anyhow::Error::new(json_error).context("load runtime config"));
        assert!(detail.contains("load runtime config"));
        assert!(!detail.contains("private-value"));
        let sqlite_error = StorageError::Sqlite(SqliteError::SqliteFailure(
            tokio_rusqlite::rusqlite::ffi::Error::new(19),
            Some("private-value from a user-defined trigger".into()),
        ));
        let failure = StorageFailure::from_error(&sqlite_error);
        assert!(!failure.message.contains("private-value"));
        assert!(failure.code.ends_with(":19"));
    }

    #[tokio::test]
    async fn stored_config_errors_are_deterministic_without_disclosing_values() {
        for (key, value, code) in [
            ("fn_knock:config", "{invalid-private-config", "invalid_json"),
            (
                "fn_knock:config:host_mappings:generation",
                "invalid-private-counter",
                "invalid_configuration",
            ),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("db");
            let store = crate::store::Store::connect(&path).await.unwrap();
            store.checkpoint_for_shutdown().await.unwrap();
            drop(store);
            let conn = tokio_rusqlite::rusqlite::Connection::open(&path).unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO kv_keys(key, kind) VALUES (?1, 'string')",
                [key],
            )
            .unwrap();
            conn.execute("INSERT INTO kv_strings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]).unwrap();
            drop(conn);
            let error = match crate::store::Store::connect(&path).await {
                Ok(_) => panic!("invalid config accepted"),
                Err(error) => error,
            };
            let failure = StorageFailure::from_error(&error);
            assert_eq!(failure.stage, Some("config.load"));
            assert_eq!(failure.code, code);
            assert!(!failure.retryable);
            assert!(!failure.message.contains(value));
        }
    }

    #[tokio::test]
    async fn invalid_reader_environment_fails_before_database_creation() {
        // Isolate the invalid process environment from concurrently running Store tests.
        if std::env::var_os("FN_KNOCK_READER_DIAGNOSTIC_CHILD").is_none() {
            let result = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "storage::startup_diagnostics::tests::invalid_reader_environment_fails_before_database_creation", "--nocapture"])
                .env("FN_KNOCK_READER_DIAGNOSTIC_CHILD", "1")
                .env("FN_KNOCK_SQLITE_AUTH_READERS", "invalid")
                .output().unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        let error = match crate::store::Store::connect(&path).await {
            Ok(_) => panic!("invalid readers accepted"),
            Err(error) => error,
        };
        let failure = StorageFailure::from_error(&error);
        assert_eq!(failure.stage, Some("config.readers"));
        assert!(!failure.retryable);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn store_reports_schema_and_configuration_failures_at_their_stage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let store = crate::store::Store::connect(&path).await.unwrap();
        drop(store);
        let conn = tokio_rusqlite::rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE schema_migrations SET checksum = 'invalid' WHERE version = 1",
            [],
        )
        .unwrap();
        let error = match crate::store::Store::connect(&path).await {
            Ok(_) => panic!("invalid checksum accepted"),
            Err(error) => error,
        };
        let report = StorageFailure::from_error(&error);
        assert_eq!(report.stage, Some("schema.base"));
        assert_eq!(report.code, "migration_incompatible");
        assert!(!report.retryable);
    }

    #[tokio::test]
    async fn recorded_migration_with_missing_table_is_deterministic() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let store = crate::store::Store::connect(&path).await.unwrap();
        drop(store);
        let conn = tokio_rusqlite::rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("DROP TABLE config_documents").unwrap();
        drop(conn);
        let Err(error) = crate::store::Store::connect(&path).await else {
            panic!("missing table accepted")
        };
        let failure = StorageFailure::from_error(&error);
        assert_eq!(failure.stage, Some("schema.typed_config"));
        assert_eq!(failure.code, "migration_incompatible");
        assert!(!failure.retryable);
    }

    #[tokio::test]
    async fn exclusive_writer_reports_busy_during_wal_initialization() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let conn = tokio_rusqlite::rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE fixture (id INTEGER); BEGIN EXCLUSIVE")
            .unwrap();
        let Err(error) = crate::store::Store::connect(&path).await else {
            panic!("exclusive writer bypassed")
        };
        let failure = StorageFailure::from_error(&error);
        assert_eq!(failure.stage, Some("connection.wal"));
        assert!(failure.code.starts_with("sqlite:DatabaseBusy:"));
        assert!(failure.retryable);
    }

    #[tokio::test]
    async fn unusable_wal_companion_preserves_sqlite_code() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let conn = tokio_rusqlite::rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE fixture (id INTEGER)")
            .unwrap();
        drop(conn);
        std::fs::create_dir(dir.path().join("db-wal")).unwrap();
        let Err(error) = crate::store::Store::connect(&path).await else {
            panic!("unusable WAL accepted")
        };
        let failure = StorageFailure::from_error(&error);
        assert!(failure.code.starts_with("sqlite:"));
        assert!(failure.stage.is_some());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn readonly_file_attribute_is_a_deterministic_storage_failure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let conn = tokio_rusqlite::rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE fixture (id INTEGER)")
            .unwrap();
        drop(conn);
        let original = std::fs::metadata(&path).unwrap().permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&path, readonly).unwrap();
        let result = crate::store::Store::connect(&path).await;
        std::fs::set_permissions(&path, original).unwrap();
        let Err(error) = result else {
            panic!("readonly database accepted")
        };
        let failure = StorageFailure::from_error(&error);
        assert!(failure.code.starts_with("sqlite:ReadOnly:"));
        assert!(!failure.retryable);
    }
}
