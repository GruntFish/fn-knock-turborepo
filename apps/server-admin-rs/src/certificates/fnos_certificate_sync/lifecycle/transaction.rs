use super::*;

/// Only the first read-only guard can prove that no external mutation was attempted.
#[derive(Debug)]
pub(super) struct BeforeMutation;
impl std::fmt::Display for BeforeMutation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("fnOS certificate preflight failed before any changes")
    }
}
impl std::error::Error for BeforeMutation {}

/// Shared ordering for live mutations and deterministic failure-injection tests.
pub(super) trait Backend {
    fn guard(
        &mut self,
        journal: &Journal,
        reverse: bool,
        allow_derived_gateway: bool,
    ) -> anyhow::Result<()>;
    fn gateway(&mut self, journal: &Journal, reverse: bool) -> anyhow::Result<()>;
    fn directories(&mut self, journal: &Journal, reverse: bool) -> anyhow::Result<()>;
    fn verify_restore(&mut self, journal: &Journal) -> anyhow::Result<()>;
    fn check(&mut self, file: &FileChange) -> anyhow::Result<()>;
    fn file(&mut self, file: &FileChange, reverse: bool) -> anyhow::Result<()>;
    fn rows(&mut self, rows: &[RowChange], reverse: bool) -> anyhow::Result<()>;
    fn refresh(&mut self) -> anyhow::Result<()>;
    fn verify(&mut self, journal: &Journal) -> anyhow::Result<()>;
}
pub(super) struct Native<'a> {
    pub data_dir: &'a Path,
    pub selected: &'a [&'a Action],
    // Recovery must remain possible even if the gateway settings are damaged.
    pub https_port: Option<u16>,
}
impl Backend for Native<'_> {
    fn gateway(&mut self, journal: &Journal, reverse: bool) -> anyhow::Result<()> {
        gateway::reconcile(journal, reverse, self.data_dir)
    }

    fn directories(&mut self, journal: &Journal, reverse: bool) -> anyhow::Result<()> {
        permissions::apply_directories(journal, reverse, self.data_dir)
    }
    fn guard(
        &mut self,
        journal: &Journal,
        reverse: bool,
        allow_derived_gateway: bool,
    ) -> anyhow::Result<()> {
        if !reverse {
            tls_probe::verify_configured_port(
                self.https_port
                    .ok_or_else(|| anyhow!("Missing planned fnOS HTTPS port"))?,
            )?;
        }
        permissions::check_directories(journal)?;
        let current = snapshot(self.data_dir)?;
        // Old journals must not be restored into a different supported layout.
        current.schema.verify_changes(&journal.rows)?;
        check_removals(journal, &current, reverse, allow_derived_gateway)?;
        if allow_derived_gateway
            && gateway::live_plan(journal, &current, reverse, self.data_dir)? != current.gateway
        {
            // Detect unsafe gateway writes before rows or certificate files change.
            validate_write_location(Path::new(NETWORK_GATEWAY_INDEX), self.data_dir)?;
            permissions::check_path_access_rules(Path::new(NETWORK_GATEWAY_INDEX))?;
        }
        Ok(())
    }
    fn verify_restore(&mut self, journal: &Journal) -> anyhow::Result<()> {
        verify_restored(journal, self.data_dir)
    }
    fn check(&mut self, file: &FileChange) -> anyhow::Result<()> {
        validate_write_location(Path::new(&file.path), self.data_dir)?;
        check_file(file, true)
    }
    fn file(&mut self, file: &FileChange, reverse: bool) -> anyhow::Result<()> {
        apply_file(file, reverse, self.data_dir).with_context(|| {
            format!(
                "{} certificate file {}",
                if reverse { "Restore" } else { "Apply" },
                file.path
            )
        })
    }
    fn rows(&mut self, rows: &[RowChange], reverse: bool) -> anyhow::Result<()> {
        apply_rows(rows, reverse)
    }
    fn refresh(&mut self) -> anyhow::Result<()> {
        restart_and_verify_services()
    }
    fn verify(&mut self, journal: &Journal) -> anyhow::Result<()> {
        verify_applied(
            journal,
            self.selected,
            self.data_dir,
            self.https_port
                .ok_or_else(|| anyhow!("Missing planned fnOS HTTPS port"))?,
        )
    }
}
pub(super) fn apply(journal: &Journal, backend: &mut impl Backend) -> anyhow::Result<()> {
    let preflight = (|| {
        backend.guard(journal, false, true)?;
        for file in journal
            .files
            .iter()
            .chain(std::iter::once(&journal.registry))
        {
            backend.check(file)?;
        }
        Ok::<(), anyhow::Error>(())
    })();
    preflight.map_err(|error| error.context(BeforeMutation))?;
    backend.directories(journal, false)?;
    for file in journal
        .files
        .iter()
        .filter(|f| f.path != NETWORK_CERT_INDEX && f.after.is_some())
    {
        backend.file(file, false)?;
    }
    backend.guard(journal, false, true)?;
    backend.rows(&journal.rows, false)?;
    for file in journal
        .files
        .iter()
        .filter(|f| f.path == NETWORK_CERT_INDEX)
    {
        backend.file(file, false)?;
    }
    backend.gateway(journal, false)?;
    backend.refresh()?;
    for file in journal.files.iter().filter(|f| f.after.is_none()) {
        backend.guard(journal, false, false)?;
        backend.file(file, false)?;
    }
    backend.verify(journal)?;
    backend.file(&journal.registry, false)?;
    Ok(())
}
pub(super) fn restore(journal: &Journal, backend: &mut impl Backend) -> anyhow::Result<()> {
    backend.guard(journal, true, true)?;
    for file in journal
        .files
        .iter()
        .chain(std::iter::once(&journal.registry))
    {
        backend.check(file)?;
    }
    backend.rows(&journal.rows, true)?;
    // Restore all retained files before publishing the restored index. New files
    // stay intact until fnOS has regenerated its SNI map without those certificates.
    for file in journal
        .files
        .iter()
        .filter(|f| f.path != NETWORK_CERT_INDEX && f.before.is_some())
    {
        backend.file(file, true)?;
    }
    for file in journal
        .files
        .iter()
        .filter(|f| f.path == NETWORK_CERT_INDEX)
    {
        backend.file(file, true)?;
    }
    backend.gateway(journal, true)?;
    backend
        .refresh()
        .context("Restart fnOS services during recovery")?;
    backend.guard(journal, true, false)?;
    for file in journal
        .files
        .iter()
        .filter(|f| f.path != NETWORK_CERT_INDEX && f.before.is_none())
    {
        backend.guard(journal, true, false)?;
        backend.file(file, true)?;
    }
    backend.file(&journal.registry, true)?;
    backend.directories(journal, true)?;
    backend
        .verify_restore(journal)
        .context("Verify restored fnOS certificates")
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        files: BTreeMap<String, Option<String>>,
        row: Option<Value>,
        fail: Option<&'static str>,
        bind_after_refresh: bool,
        bound: bool,
        refreshes: usize,
        permission_writes: usize,
        guards: usize,
    }
    impl Fake {
        fn checkpoint(&mut self, name: &str) -> anyhow::Result<()> {
            if self.fail == Some(name) {
                self.fail = None;
                bail!("Injected {name} failure")
            }
            Ok(())
        }
    }
    impl Backend for Fake {
        fn gateway(&mut self, _journal: &Journal, _reverse: bool) -> anyhow::Result<()> {
            self.checkpoint("gateway")
        }
        fn directories(&mut self, _journal: &Journal, _reverse: bool) -> anyhow::Result<()> {
            self.checkpoint("permissions")?;
            self.permission_writes += 1;
            Ok(())
        }
        fn guard(
            &mut self,
            journal: &Journal,
            reverse: bool,
            allow_derived_gateway: bool,
        ) -> anyhow::Result<()> {
            let _ = allow_derived_gateway;
            self.guards += 1;
            if self.guards == 2 {
                self.checkpoint("second_guard")?;
            }
            self.checkpoint("guard")?;
            if self.bound
                && journal.rows.iter().any(|row| {
                    if reverse {
                        row.before.is_none()
                    } else {
                        row.after.is_none()
                    }
                })
            {
                bail!("Certificate acquired a reference")
            }
            Ok(())
        }
        fn verify_restore(&mut self, _journal: &Journal) -> anyhow::Result<()> {
            self.checkpoint("restore_verify")
        }
        fn check(&mut self, f: &FileChange) -> anyhow::Result<()> {
            let value = self.files.get(&f.path).cloned().flatten();
            if value != f.before && value != f.after {
                bail!("External file change")
            }
            Ok(())
        }
        fn file(&mut self, f: &FileChange, reverse: bool) -> anyhow::Result<()> {
            self.checkpoint(if f.path == NETWORK_CERT_INDEX {
                "index"
            } else {
                "file"
            })?;
            self.check(f)?;
            self.files.insert(
                f.path.clone(),
                if reverse {
                    f.before.clone()
                } else {
                    f.after.clone()
                },
            );
            Ok(())
        }
        fn rows(&mut self, rows: &[RowChange], reverse: bool) -> anyhow::Result<()> {
            self.checkpoint("database")?;
            for row in rows {
                if self.row != row.before && !(reverse && self.row == row.after) {
                    bail!("External database change")
                }
                self.row = if reverse {
                    row.before.clone()
                } else {
                    row.after.clone()
                };
            }
            Ok(())
        }
        fn refresh(&mut self) -> anyhow::Result<()> {
            self.refreshes += 1;
            self.checkpoint("refresh")?;
            self.bound |= self.bind_after_refresh;
            Ok(())
        }
        fn verify(&mut self, _journal: &Journal) -> anyhow::Result<()> {
            self.checkpoint("verify")
        }
    }
    fn fixture(kind: &str) -> (Journal, Fake) {
        let before = if kind == "create" {
            None
        } else {
            Some("old".into())
        };
        let after = if kind == "delete" {
            None
        } else {
            Some("new".into())
        };
        let files = vec![
            FileChange {
                applied_metadata: None,
                original_metadata: None,
                path: "cert".into(),
                before: before.clone(),
                after: after.clone(),
            },
            FileChange {
                applied_metadata: None,
                original_metadata: None,
                path: NETWORK_CERT_INDEX.into(),
                before: Some("old-index".into()),
                after: Some("new-index".into()),
            },
        ];
        let registry = FileChange {
            applied_metadata: None,
            original_metadata: None,
            path: "registry".into(),
            before: Some("old-registry".into()),
            after: Some("new-registry".into()),
        };
        let row_before = before.map(Value::from);
        let row_after = after.map(Value::from);
        let backend = Fake {
            files: files
                .iter()
                .chain(std::iter::once(&registry))
                .map(|f| (f.path.clone(), f.before.clone()))
                .collect(),
            row: row_before.clone(),
            fail: None,
            bind_after_refresh: false,
            refreshes: 0,
            permission_writes: 0,
            guards: 0,
            bound: false,
        };
        (
            Journal {
                gateway_before: None,
                directories: Vec::new(),
                completed: false,
                files,
                rows: vec![RowChange {
                    table: "cert".into(),
                    id: 1,
                    before: row_before,
                    after: row_after,
                }],
                registry,
            },
            backend,
        )
    }
    // Exercise the actual removal guard with multiple rows and index entries,
    // rather than the single-target reference flag used by the other fault tests.
    struct BatchFake {
        inner: Fake,
        snapshot: Snapshot,
        regenerate_mapping: Option<Value>,
    }
    impl Backend for BatchFake {
        fn gateway(&mut self, journal: &Journal, reverse: bool) -> anyhow::Result<()> {
            self.inner.checkpoint("gateway")?;
            self.snapshot.gateway = gateway::reconciled(journal, &self.snapshot, reverse)?;
            Ok(())
        }
        fn guard(
            &mut self,
            journal: &Journal,
            reverse: bool,
            allow_derived_gateway: bool,
        ) -> anyhow::Result<()> {
            self.inner.guard(journal, reverse, allow_derived_gateway)?;
            check_removals(journal, &self.snapshot, reverse, allow_derived_gateway)
        }
        fn directories(&mut self, journal: &Journal, reverse: bool) -> anyhow::Result<()> {
            self.inner.directories(journal, reverse)
        }
        fn verify_restore(&mut self, journal: &Journal) -> anyhow::Result<()> {
            self.inner.verify_restore(journal)?;
            for row in &journal.rows {
                anyhow::ensure!(
                    self.snapshot.rows.iter().find(|r| r["id"] == row.id) == row.before.as_ref(),
                    "Batch row was not restored"
                );
            }
            for file in journal
                .files
                .iter()
                .chain(std::iter::once(&journal.registry))
            {
                anyhow::ensure!(
                    self.inner.files[&file.path] == file.before,
                    "Batch file was not restored"
                );
            }
            Ok(())
        }
        fn check(&mut self, file: &FileChange) -> anyhow::Result<()> {
            self.inner.check(file)
        }
        fn file(&mut self, file: &FileChange, reverse: bool) -> anyhow::Result<()> {
            self.inner.file(file, reverse)?;
            if file.path == NETWORK_CERT_INDEX {
                let contents = self.inner.files[&file.path].as_ref().unwrap();
                self.snapshot.index = serde_json::from_slice(&BASE64_STANDARD.decode(contents)?)?;
            }
            Ok(())
        }
        fn rows(&mut self, rows: &[RowChange], reverse: bool) -> anyhow::Result<()> {
            self.inner.checkpoint("database")?;
            let mut updated = self.snapshot.rows.clone();
            for change in rows {
                let current = updated.iter().find(|row| row["id"] == change.id);
                anyhow::ensure!(
                    current == change.before.as_ref()
                        || reverse && current == change.after.as_ref(),
                    "External batch row change"
                );
                updated.retain(|row| row["id"] != change.id);
                if let Some(row) = if reverse {
                    &change.before
                } else {
                    &change.after
                } {
                    updated.push(row.clone());
                }
            }
            self.snapshot.rows = updated;
            Ok(())
        }
        fn refresh(&mut self) -> anyhow::Result<()> {
            self.inner.refresh()?;
            if let Some(mapping) = &self.regenerate_mapping {
                self.snapshot.gateway = vec![mapping.clone()];
            }
            Ok(())
        }
        fn verify(&mut self, journal: &Journal) -> anyhow::Result<()> {
            self.inner.verify(journal)
        }
    }

    #[test]
    fn generated_gateway_recovery_never_unlinks_before_refresh_and_reference_checks() {
        for failure in ["gateway", "refresh", "stale_mapping", "external_mapping"] {
            let (mut snapshot, mapping) = gateway::tests::fixture();
            let (mut journal, _) = super::super::tests::batch_removal_fixture(true);
            journal.rows.truncate(1);
            journal.rows[0].after = Some(snapshot.rows[0].clone());
            journal.gateway_before = Some(vec![]);
            journal.files.retain(|f| f.path == NETWORK_CERT_INDEX);
            journal.files[0].after =
                Some(BASE64_STANDARD.encode(serde_json::to_vec(&snapshot.index).unwrap()));
            for path in file_paths(&snapshot.rows[0], &snapshot.index) {
                journal.files.push(FileChange {
                    path,
                    before: None,
                    after: Some(BASE64_STANDARD.encode(b"new")),
                    original_metadata: None,
                    applied_metadata: None,
                });
            }
            snapshot.rows.clear();
            snapshot.index.clear();
            snapshot.gateway.clear();
            let (_, mut inner) = fixture("create");
            inner.files = journal
                .files
                .iter()
                .chain(std::iter::once(&journal.registry))
                .map(|file| (file.path.clone(), file.before.clone()))
                .collect();
            inner.fail = Some("verify");
            let mut backend = BatchFake {
                inner,
                snapshot,
                regenerate_mapping: Some(mapping.clone()),
            };
            assert!(apply(&journal, &mut backend).is_err());
            assert_eq!(backend.snapshot.gateway, vec![mapping.clone()]);
            backend.regenerate_mapping = None;
            match failure {
                "stale_mapping" => backend.regenerate_mapping = Some(mapping.clone()),
                "external_mapping" => {
                    backend.snapshot.gateway[0]["host"] = json!("external.example.test")
                }
                _ => backend.inner.fail = Some(failure),
            }
            assert!(restore(&journal, &mut backend).is_err(), "{failure}");
            for file in journal.files.iter().filter(|f| f.before.is_none()) {
                assert_eq!(
                    backend.inner.files[&file.path], file.after,
                    "{failure}: prematurely removed {}",
                    file.path
                );
            }
            backend.regenerate_mapping = None;
            if failure == "external_mapping" {
                backend.snapshot.gateway = vec![mapping];
            }
            restore(&journal, &mut backend).unwrap();
            restore(&journal, &mut backend).unwrap();
            assert!(backend.snapshot.gateway.is_empty());
            assert!(backend.snapshot.rows.is_empty());
            for file in &journal.files {
                assert_eq!(backend.inner.files[&file.path], file.before);
            }
        }
    }

    #[test]
    fn batch_creation_recovers_with_real_reference_guards_after_each_failure_stage() {
        for phase in ["database", "index", "gateway", "refresh", "verify"] {
            for recovery_phase in [
                "database",
                "file",
                "index",
                "gateway",
                "refresh",
                "restore_verify",
            ] {
                let (mut journal, mut snapshot) = super::super::tests::batch_removal_fixture(true);
                // Production paths sort the network index before certificate files.
                journal.files.rotate_right(1);
                snapshot.rows.clear();
                snapshot.index.clear();
                let (_, mut inner) = fixture("create");
                inner.files = journal
                    .files
                    .iter()
                    .chain(std::iter::once(&journal.registry))
                    .map(|file| (file.path.clone(), file.before.clone()))
                    .collect();
                inner.fail = Some(phase);
                let before = inner.files.clone();
                let mut backend = BatchFake {
                    inner,
                    snapshot,
                    regenerate_mapping: None,
                };
                assert!(apply(&journal, &mut backend).is_err(), "{phase}");
                backend.inner.fail = Some(recovery_phase);
                assert!(
                    restore(&journal, &mut backend).is_err(),
                    "{phase}/{recovery_phase}"
                );
                restore(&journal, &mut backend).unwrap();
                restore(&journal, &mut backend).unwrap();
                assert!(backend.snapshot.rows.is_empty(), "{phase}/{recovery_phase}");
                assert!(
                    backend.snapshot.index.is_empty(),
                    "{phase}/{recovery_phase}"
                );
                assert_eq!(backend.inner.files, before, "{phase}/{recovery_phase}");
            }
        }
    }

    #[test]
    fn external_file_edits_fail_before_directory_database_or_service_changes() {
        for kind in ["create", "update", "delete"] {
            let (journal, mut backend) = fixture(kind);
            backend.files.insert("cert".into(), Some("external".into()));
            let before = backend.files.clone();
            let row = backend.row.clone();
            let error = apply(&journal, &mut backend).unwrap_err();
            assert!(error.is::<BeforeMutation>());
            assert_eq!(backend.permission_writes, 0);
            assert_eq!(backend.refreshes, 0);
            assert_eq!(backend.files, before);
            assert_eq!(backend.row, row);
        }
    }

    #[test]
    fn recovery_failure_does_not_restart_services_on_subsequent_automatic_ticks() {
        let dir = tempfile::tempdir().unwrap();
        let (journal, mut backend) = fixture("update");
        apply(&journal, &mut backend).unwrap();
        let initial_refreshes = backend.refreshes;
        backend.fail = Some("restore_verify");
        for _ in 0..3 {
            assert!(
                automatic::run(dir.path(), true, || {
                    automatic::mark_attempt(dir.path())?;
                    restore(&journal, &mut backend)
                })
                .is_err()
            );
        }
        assert_eq!(backend.refreshes, initial_refreshes + 1);
        assert_eq!(backend.row, journal.rows[0].before);
        automatic::run(dir.path(), false, || restore(&journal, &mut backend)).unwrap();
        assert!(!automatic::automatic_paused(dir.path()).unwrap());
    }

    #[test]
    fn first_guard_failure_is_identified_without_touching_files_rows_or_services() {
        let (journal, mut backend) = fixture("update");
        let before = backend.files.clone();
        let row = backend.row.clone();
        backend.fail = Some("guard");
        let error = apply(&journal, &mut backend).unwrap_err();
        assert!(error.is::<BeforeMutation>());
        assert!(format!("{error:#}").contains("Injected guard failure"));
        assert_eq!(backend.files, before);
        assert_eq!(backend.row, row);
        assert_eq!(backend.refreshes, 0);
    }

    #[test]
    fn every_failure_stage_restores_create_update_and_delete() {
        for kind in ["create", "update", "delete"] {
            for phase in [
                "guard",
                "second_guard",
                "permissions",
                "file",
                "database",
                "index",
                "gateway",
                "refresh",
                "verify",
            ] {
                let (journal, mut backend) = fixture(kind);
                let before = backend.files.clone();
                let row = backend.row.clone();
                backend.fail = Some(phase);
                let error = apply(&journal, &mut backend).unwrap_err();
                assert_eq!(
                    error.is::<BeforeMutation>(),
                    phase == "guard",
                    "{kind}/{phase}"
                );
                // Failed TLS/database/file verification must never publish new ownership.
                assert_eq!(
                    backend.files["registry"], before["registry"],
                    "{kind}/{phase}"
                );
                restore(&journal, &mut backend).unwrap();
                restore(&journal, &mut backend).unwrap();
                assert_eq!(backend.files, before, "{kind}/{phase}");
                assert_eq!(backend.row, row, "{kind}/{phase}");
            }
        }
    }
    #[test]
    fn verification_failure_rolls_back_and_latches_automation_without_restarting_on_ticks() {
        let dir = tempfile::tempdir().unwrap();
        let (journal, mut backend) = fixture("update");
        let before = backend.files.clone();
        let row_before = backend.row.clone();
        backend.fail = Some("verify");
        let error = automatic::run(dir.path(), true, || {
            automatic::mark_attempt(dir.path())?;
            let error = apply(&journal, &mut backend).unwrap_err();
            assert_eq!(backend.files["registry"], before["registry"]);
            restore(&journal, &mut backend)?;
            Err::<(), _>(error)
        })
        .unwrap_err();
        assert!(error.to_string().contains("verify"));
        assert_eq!(backend.files, before);
        assert_eq!(backend.row, row_before);
        assert_eq!(backend.refreshes, 2); // One application and one rollback.
        assert!(automatic::automatic_paused(dir.path()).unwrap());
        for _ in 0..3 {
            assert!(automatic::run(dir.path(), true, || apply(&journal, &mut backend)).is_err());
        }
        assert_eq!(backend.refreshes, 2);
    }

    #[test]
    fn a_reference_added_by_refresh_stops_unlinking_and_is_preserved_on_rollback() {
        let (journal, mut backend) = fixture("delete");
        backend.bind_after_refresh = true;
        assert!(apply(&journal, &mut backend).is_err());
        assert_eq!(backend.files["cert"], journal.files[0].before);
        restore(&journal, &mut backend).unwrap();
        assert!(backend.bound);
        assert_eq!(backend.row, journal.rows[0].before);
        let (created, mut backend) = fixture("create");
        apply(&created, &mut backend).unwrap();
        backend.bound = true;
        assert!(restore(&created, &mut backend).is_err());
        assert_eq!(backend.row, created.rows[0].after);
    }
    #[test]
    fn failed_recovery_verification_is_not_reported_as_success() {
        let (journal, mut backend) = fixture("update");
        apply(&journal, &mut backend).unwrap();
        backend.fail = Some("restore_verify");
        assert!(restore(&journal, &mut backend).is_err());
        restore(&journal, &mut backend).unwrap();
        assert_eq!(backend.row, journal.rows[0].before);
    }
    #[test]
    fn crash_after_database_commit_can_be_recovered_and_external_edits_are_preserved() {
        let (journal, mut backend) = fixture("update");
        backend.file(&journal.files[0], false).unwrap();
        backend.rows(&journal.rows, false).unwrap();
        backend.files.insert("cert".into(), Some("external".into()));
        assert!(restore(&journal, &mut backend).is_err());
        assert_eq!(backend.row, journal.rows[0].after);
        assert_eq!(backend.files["cert"], Some("external".into()));
        backend
            .files
            .insert("cert".into(), journal.files[0].after.clone());
        restore(&journal, &mut backend).unwrap();
        assert_eq!(backend.row, journal.rows[0].before);
    }
}
