//! Runs initialization exclusively against a disposable database copy.
use super::{StorageError, StorageResultExt, startup_diagnostics::StorageFailure};
use serde::Serialize;
use std::path::Path;
use tokio_rusqlite::rusqlite::{Connection, OpenFlags};

const MIGRATION_TABLES: &[&str] = &[
    "schema_migrations",
    "typed_docker_admin_schema_migrations",
    "typed_event_schema_migrations",
    "typed_fnos_share_schema_migrations",
    "typed_hmac_nonce_schema_migrations",
    "typed_identity_runtime_schema_migrations",
    "typed_login_backoff_schema_migrations",
    "typed_mobility_schema_migrations",
    "typed_notification_runtime_schema_migrations",
    "typed_notification_schema_migrations",
    "typed_passkey_runtime_schema_migrations",
    "typed_schema_migrations",
    "typed_subdomain_grant_schema_migrations",
    "typed_subdomain_rule_rate_limit_schema_migrations",
    "typed_system_event_dedupe_schema_migrations",
    "typed_whitelist_runtime_schema_migrations",
    "typed_whitelist_schema_migrations",
    "typed_wol_cooldown_schema_migrations",
];

const MIGRATION_NAMES: &[&str] = &[
    "redis_compatible_keyspace",
    "redis_compatible_stream_metadata",
    "typed_auth_mobility_aggregates",
    "typed_config_document",
    "typed_docker_admin_security_state",
    "typed_fnos_share_runtime",
    "typed_hmac_replay_nonces",
    "typed_identity_runtime_aggregates",
    "typed_login_backoff_attempts",
    "typed_notification_documents",
    "typed_notification_history",
    "typed_notification_history_trace_index",
    "typed_notification_runtime",
    "typed_passkey_runtime_capabilities",
    "typed_subdomain_rule_grants",
    "typed_subdomain_rule_rate_limits",
    "typed_system_event_dedupe_leases",
    "typed_system_event_trace_index",
    "typed_system_events",
    "typed_whitelist_documents",
    "typed_whitelist_owner_runtime",
    "typed_wol_wake_cooldowns",
];

#[derive(Default, Serialize)]
pub(crate) struct CopyReport {
    pub integrity_check: bool,
    pub initialization_passed: bool,
    /// None means startup failed before migration validation completed.
    pub migration_validation: Option<bool>,
    pub migrations: Vec<MigrationRecord>,
    /// Metadata inspection failures do not replace the real Store initialization result.
    pub migration_inspection_failure: Option<StorageFailure>,
    pub failure: Option<StorageFailure>,
}

#[derive(Serialize)]
pub(crate) struct MigrationRecord {
    table: String,
    version: i64,
    name: String,
    checksum: String,
}

pub(crate) async fn inspect_copy(path: &Path) -> CopyReport {
    let mut report = CopyReport::default();
    let check = (|| -> Result<(), StorageError> {
        // Recovery of a copied hot journal/WAL is allowed only in the copy.
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .storage_stage("diagnostic.open_copy")?;
        let result = (|| -> Result<(), StorageError> {
            let mut statement = conn.prepare("PRAGMA integrity_check")?;
            let checks = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            if checks != ["ok"] {
                return Err(StorageError::Sqlite(
                    tokio_rusqlite::rusqlite::Error::SqliteFailure(
                        tokio_rusqlite::rusqlite::ffi::Error::new(11),
                        Some("database integrity check failed".into()),
                    ),
                ));
            }
            Ok(())
        })()
        .storage_stage("diagnostic.integrity_check");
        result?;
        report.integrity_check = true;
        let metadata = (|| -> Result<(), StorageError> {
            for &table in MIGRATION_TABLES {
                let exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )?;
                if !exists {
                    continue;
                }
                let mut rows = conn.prepare(&format!(
                    "SELECT version, name, checksum FROM \"{table}\" ORDER BY version LIMIT 64"
                ))?;
                for row in rows.query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })? {
                    let (version, name, checksum) = row?;
                    // Metadata can be corrupted or adversarial too. Never export arbitrary values.
                    let name = if MIGRATION_NAMES.contains(&name.as_str()) {
                        name
                    } else {
                        "[invalid migration name]".into()
                    };
                    let digest = checksum.strip_prefix("sha256:").unwrap_or(&checksum);
                    let checksum = if (digest.len() == 64
                        && digest.bytes().all(|b| b.is_ascii_hexdigit()))
                        || checksum == "v1"
                    {
                        checksum
                    } else {
                        "[invalid checksum]".into()
                    };
                    report.migrations.push(MigrationRecord {
                        table: table.to_string(),
                        version,
                        name,
                        checksum,
                    });
                }
            }
            Ok(())
        })()
        .storage_stage("diagnostic.migration_records");
        if let Err(error) = metadata {
            report.migration_inspection_failure = Some(StorageFailure::from_error(&error));
        }
        Ok(())
    })()
    .storage_stage("diagnostic.inspect_copy");
    if let Err(error) = check {
        report.failure = Some(StorageFailure::from_error(&error));
        return report;
    }
    match crate::store::Store::connect(path).await {
        Ok(store) => {
            report.migration_validation = Some(true);
            // Drop workers before the caller removes the temporary directory.
            match store.checkpoint_for_shutdown().await {
                Ok(()) => report.initialization_passed = true,
                Err(error) => report.failure = Some(StorageFailure::from_error(&error)),
            }
            drop(store);
        }
        Err(error) => {
            let failure = StorageFailure::from_error(&error);
            if failure.code == "migration_incompatible" {
                report.migration_validation = Some(false);
            } else if failure
                .stage
                .is_some_and(|stage| stage == "config.load" || stage.starts_with("rebuild."))
            {
                // Every migration initializer precedes rebuilding and configuration loading.
                report.migration_validation = Some(true);
            }
            report.failure = Some(failure);
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn metadata_inspection_cannot_mask_initialization_or_export_arbitrary_names() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let store = crate::store::Store::connect(&path).await.unwrap();
        drop(store);
        let conn = Connection::open(&path).unwrap();
        // The old wildcard query read this unrelated table and failed before Store::connect.
        conn.execute_batch("CREATE TABLE typed_private_schema_migrations (private_data TEXT)")
            .unwrap();
        let healthy = inspect_copy(&path).await;
        assert!(healthy.initialization_passed);
        assert!(healthy.migration_inspection_failure.is_none());
        assert!(
            healthy
                .migrations
                .iter()
                .all(|row| MIGRATION_NAMES.contains(&row.name.as_str()))
        );
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%schema_migrations'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            tables
                .iter()
                .filter(|name| name.as_str() != "typed_private_schema_migrations")
                .all(|name| MIGRATION_TABLES.contains(&name.as_str()))
        );
        conn.execute(
            "UPDATE schema_migrations SET name = 'privatecredential' WHERE version = 1",
            [],
        )
        .unwrap();
        let report = inspect_copy(&path).await;
        assert!(
            !serde_json::to_string(&report)
                .unwrap()
                .contains("privatecredential")
        );
        assert_eq!(report.failure.unwrap().stage, Some("schema.base"));
        // Malformed migration columns must still exercise the real Store initialization.
        conn.execute_batch(
            "DROP TABLE schema_migrations; CREATE TABLE schema_migrations (version INTEGER)",
        )
        .unwrap();
        let report = inspect_copy(&path).await;
        assert!(report.migration_inspection_failure.is_some());
        assert_eq!(report.failure.unwrap().stage, Some("schema.base"));
    }

    #[tokio::test]
    async fn corrupt_btree_is_detected_before_initialization() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE fixture (id INTEGER)")
            .unwrap();
        drop(conn);
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[100] = 0xff; // Invalid page type in sqlite_schema, preserving the SQLite header.
        std::fs::write(&path, bytes).unwrap();
        let report = inspect_copy(&path).await;
        assert!(!report.integrity_check);
        assert!(!report.initialization_passed);
        let failure = report.failure.unwrap();
        assert!(failure.code.starts_with("sqlite:DatabaseCorrupt:"));
        assert!(!failure.retryable);
    }

    #[tokio::test]
    async fn offline_copy_reports_damage_and_migration_failure() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db");
        std::fs::write(&path, b"not a SQLite database").unwrap();
        let report = inspect_copy(&path).await;
        assert!(!report.integrity_check);
        assert!(
            report
                .failure
                .unwrap()
                .code
                .starts_with("sqlite:NotADatabase")
        );
        std::fs::remove_file(&path).unwrap();
        let store = crate::store::Store::connect(&path).await.unwrap();
        store.checkpoint_for_shutdown().await.unwrap();
        drop(store);
        let healthy = inspect_copy(&path).await;
        assert!(healthy.initialization_passed);
        assert_eq!(healthy.migration_validation, Some(true));
        assert!(!healthy.migrations.is_empty());
        let conn = Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE schema_migrations SET checksum = 'bad' WHERE version = 1",
            [],
        )
        .unwrap();
        drop(conn);
        let report = inspect_copy(&path).await;
        assert!(report.integrity_check);
        assert!(!report.initialization_passed);
        assert_eq!(report.migration_validation, Some(false));
        assert_eq!(report.failure.unwrap().code, "migration_incompatible");
    }
}
