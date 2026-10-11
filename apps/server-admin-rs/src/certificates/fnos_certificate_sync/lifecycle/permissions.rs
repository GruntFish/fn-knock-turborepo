//! Deployment permissions belong to the transaction, never to private recovery data.
use super::*;
mod acl;
pub(super) use acl::check_path_access_rules;
use acl::reject_extended_acl;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct Reader {
    uid: u32,
    gid: u32,
    groups: BTreeSet<u32>,
}

// Read the running service, rather than assuming www-data or trusting an unrelated nginx.
fn reader() -> anyhow::Result<Reader> {
    let output = Command::new("timeout")
        .args([
            "10",
            "systemctl",
            "show",
            "trim_nginx.service",
            "--property=MainPID",
            "--value",
        ])
        .output()
        .context("Cannot identify fnOS Nginx certificate reader")?;
    anyhow::ensure!(
        output.status.success(),
        "Cannot identify fnOS Nginx master process"
    );
    let pid: u32 = String::from_utf8(output.stdout)?.trim().parse()?;
    anyhow::ensure!(pid > 0, "fnOS Nginx is not running");
    let children = fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))?;
    let mut found = None;
    for child in children.split_whitespace() {
        let child: u32 = child.parse()?;
        let status = fs::read_to_string(format!("/proc/{child}/status"))?;
        if !status.lines().any(|line| line.trim() == "Name:\tnginx") {
            continue;
        }
        let identity = parse_identity(&status)?;
        if let Some(previous) = found {
            anyhow::ensure!(
                previous == identity,
                "fnOS Nginx workers have inconsistent identities"
            );
        }
        found = Some(identity);
    }
    found.ok_or_else(|| {
        anyhow!("No running fnOS Nginx worker; certificate permissions cannot be verified")
    })
}

fn parse_identity(status: &str) -> anyhow::Result<Reader> {
    let filesystem_id = |name: &str| -> anyhow::Result<u32> {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|line| line.split_whitespace().nth(3))
            .ok_or_else(|| anyhow!("Missing Nginx worker {name}"))?
            .parse()
            .map_err(Into::into)
    };
    Ok(Reader {
        uid: filesystem_id("Uid:")?,
        gid: filesystem_id("Gid:")?,
        groups: status
            .lines()
            .find_map(|line| line.strip_prefix("Groups:"))
            .ok_or_else(|| anyhow!("Missing Nginx worker supplementary groups"))?
            .split_whitespace()
            .map(str::parse)
            .collect::<Result<_, _>>()?,
    })
}

fn accessible(metadata: &SavedMetadata, reader: &Reader, directory: bool) -> bool {
    if reader.uid == 0 {
        return true;
    }
    let bit = if directory { 1 } else { 4 };
    let shift = if metadata.uid == reader.uid {
        6
    } else if metadata.gid == reader.gid || reader.groups.contains(&metadata.gid) {
        3
    } else {
        0
    };
    metadata.mode & (bit << shift) != 0
}

fn deployment_metadata(
    before: &SavedMetadata,
    reader: &Reader,
    directory: bool,
) -> anyhow::Result<SavedMetadata> {
    let mut after = before.clone();
    if !accessible(before, reader, directory) {
        if before.uid == reader.uid {
            after.mode |= if directory { 0o500 } else { 0o400 };
        } else {
            if after.gid != reader.gid && !reader.groups.contains(&after.gid) {
                anyhow::ensure!(
                    before.mode & 0o070 == 0,
                    "Cannot replace certificate group {}: existing group permissions would be lost; grant Nginx access explicitly",
                    before.gid
                );
                after.gid = reader.gid;
            }
            after.mode |= if directory { 0o050 } else { 0o040 };
        }
    }
    Ok(after)
}

fn directory_metadata(path: &Path) -> anyhow::Result<SavedMetadata> {
    let metadata = fs::symlink_metadata(path)?;
    anyhow::ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Unsafe certificate directory: {}",
        path.display()
    );
    #[cfg(unix)]
    {
        Ok(SavedMetadata {
            mode: metadata.mode(),
            uid: metadata.uid(),
            gid: metadata.gid(),
        })
    }
    #[cfg(not(unix))]
    {
        bail!("fnOS certificate permissions require Unix")
    }
}

fn owned_directory(path: &Path) -> bool {
    path.parent() == Some(Path::new(CERT_ROOT))
        && path
            .file_name()
            .and_then(|v| v.to_str())
            .and_then(|v| v.strip_prefix("fn-knock-"))
            .is_some_and(|v| Uuid::parse_str(v).is_ok())
}

// Never chmod fnOS-owned parent trees. Only our own generated leaf directories may change.
fn inspect_parents(path: &Path, reader: &Reader) -> anyhow::Result<Vec<(PathBuf, SavedMetadata)>> {
    let mut result = Vec::new();
    for parent in path.ancestors().skip(1) {
        match directory_metadata(parent) {
            Ok(metadata) => {
                reject_extended_acl(parent)?;
                if !accessible(&metadata, reader, true) && !owned_directory(parent) {
                    bail!(
                        "fnOS Nginx cannot traverse certificate directory {}; repair its access permissions before synchronization",
                        parent.display()
                    );
                }
                result.push((parent.to_owned(), metadata));
            }
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                    && owned_directory(parent) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(result)
}

pub(super) fn extend_plan(plan: &mut Plan) -> anyhow::Result<()> {
    extend_plan_with(plan, &reader()?, |path, reader| {
        validate_target_path(path)?;
        reject_extended_acl(path)?;
        Ok((SavedMetadata::read(path)?, inspect_parents(path, reader)?))
    })
}

type InspectedPermissions = (SavedMetadata, Vec<(PathBuf, SavedMetadata)>);

fn extend_plan_with(
    plan: &mut Plan,
    reader: &Reader,
    mut inspect: impl FnMut(&Path, &Reader) -> anyhow::Result<InspectedPermissions>,
) -> anyhow::Result<()> {
    let mut observed = BTreeMap::new();
    for action in &mut plan.actions {
        // Conflicts/protected certificates remain untouched. Repair readable contents only.
        if !(matches!(action.kind, "update" | "adopt")
            || action.public["status"] == "up_to_date" && action.public["managed"] == true)
        {
            continue;
        }
        let Some(row) = &action.row else { continue };
        let raw = raw_row(&plan.snapshot, row.id)?;
        let mut repair = false;
        for path in file_paths(raw, &plan.snapshot.index) {
            let path = Path::new(&path);
            let (metadata, parents) = inspect(path, reader)?;
            repair |= !accessible(&metadata, reader, false);
            observed.insert(path.to_owned(), metadata);
            for (parent, metadata) in parents {
                repair |= !accessible(&metadata, reader, true);
                observed.insert(parent, metadata);
            }
        }
        if repair {
            action.kind = "update";
            action.public["action"] = json!("update");
            action.public["status"] = json!("syncable");
            action.public["reason"] = json!("Repair certificate permissions for fnOS Nginx");
        }
    }
    plan.version = digest(&(&plan.version, reader, observed))?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct DirectoryChange {
    path: PathBuf,
    before: SavedMetadata,
    after: SavedMetadata,
    created: bool,
}

#[cfg(unix)]
fn fresh_metadata(directory: bool) -> SavedMetadata {
    SavedMetadata {
        // POSIX file-type bits plus the private creation mode (mode_t differs by OS).
        mode: if directory { 0o040700 } else { 0o100600 },
        // SAFETY: these libc accessors have no preconditions.
        uid: unsafe { libc::geteuid() },
        gid: unsafe { libc::getegid() },
    }
}
#[cfg(not(unix))]
fn fresh_metadata(_directory: bool) -> SavedMetadata {
    SavedMetadata {
        mode: 0,
        uid: 0,
        gid: 0,
    }
}

pub(super) fn prepare(journal: &mut Journal) -> anyhow::Result<()> {
    let reader = reader()?;
    let mut directories = BTreeMap::new();
    for file in &mut journal.files {
        let path = Path::new(&file.path);
        if !path.starts_with(CERT_ROOT) || file.after.is_none() {
            continue;
        }
        reject_extended_acl(path)?;
        let before = file
            .original_metadata
            .clone()
            .unwrap_or_else(|| fresh_metadata(false));
        file.applied_metadata = Some(
            deployment_metadata(&before, &reader, false)
                .with_context(|| format!("Plan permissions for {}", path.display()))?,
        );
        for (parent, metadata) in inspect_parents(path, &reader)? {
            if owned_directory(&parent) && !accessible(&metadata, &reader, true) {
                directories.insert(
                    parent.clone(),
                    DirectoryChange {
                        path: parent.clone(),
                        after: deployment_metadata(&metadata, &reader, true).with_context(
                            || format!("Plan permissions for {}", parent.display()),
                        )?,
                        before: metadata,
                        created: false,
                    },
                );
            }
        }
        let parent = path
            .parent()
            .ok_or_else(|| anyhow!("Missing certificate parent"))?;
        if !parent.exists() {
            anyhow::ensure!(owned_directory(parent), "Unsafe new certificate directory");
            let before = fresh_metadata(true);
            directories.insert(
                parent.to_owned(),
                DirectoryChange {
                    path: parent.to_owned(),
                    after: deployment_metadata(&before, &reader, true)?,
                    before,
                    created: true,
                },
            );
        }
    }
    journal.directories = directories.into_values().collect();
    Ok(())
}

pub(super) fn check_directories(journal: &Journal) -> anyhow::Result<()> {
    for change in &journal.directories {
        anyhow::ensure!(
            owned_directory(&change.path),
            "Unsafe certificate permission recovery path"
        );
        check_path_access_rules(&change.path)?;
        check_directory_change(change)?;
    }
    Ok(())
}

pub(super) fn apply_directories(
    journal: &Journal,
    reverse: bool,
    data_dir: &Path,
) -> anyhow::Result<()> {
    check_directories(journal)?;
    for change in &journal.directories {
        // The ordinary path validator creates new directories privately and rejects symlinks.
        ensure_parent(&change.path.join("permission-check"), data_dir)?;
        let metadata = if reverse {
            &change.before
        } else {
            &change.after
        };
        metadata.restore(&change.path)?;
        sync_directory(&change.path)?;
    }
    Ok(())
}

pub(super) fn verify_directories(journal: &Journal, reverse: bool) -> anyhow::Result<()> {
    check_directories(journal)?;
    for change in &journal.directories {
        let expected = if reverse {
            &change.before
        } else {
            &change.after
        };
        anyhow::ensure!(
            directory_metadata(&change.path)? == *expected,
            "Certificate directory permission verification failed at {}",
            change.path.display()
        );
    }
    Ok(())
}

fn check_directory_change(change: &DirectoryChange) -> anyhow::Result<()> {
    match directory_metadata(&change.path) {
        Ok(current) => anyhow::ensure!(
            directory_transition_matches(&current, change),
            "Certificate directory permissions changed externally at {}; recovery backup preserved",
            change.path.display()
        ),
        Err(error)
            if change.created
                && error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) => {}
        Err(error) => return Err(error),
    }
    Ok(())
}

// Directory chown and chmod cannot be atomic. Accept only their journaled intermediate
// combinations after a crash; arbitrary owners/groups/modes still block recovery.
fn directory_transition_matches(current: &SavedMetadata, change: &DirectoryChange) -> bool {
    (current.mode == change.before.mode || current.mode == change.after.mode)
        && ((current.uid == change.before.uid && current.gid == change.before.gid)
            || (current.uid == change.after.uid && current.gid == change.after.gid))
}

pub(super) fn verify_access(journal: &Journal) -> anyhow::Result<()> {
    let files = journal
        .files
        .iter()
        .filter(|file| Path::new(&file.path).starts_with(CERT_ROOT) && file.after.is_some())
        .collect::<Vec<_>>();
    if files.is_empty() {
        return Ok(());
    }
    let reader = reader()?;
    for file in files {
        let path = Path::new(&file.path);
        anyhow::ensure!(
            accessible(&SavedMetadata::read(path)?, &reader, false),
            "fnOS Nginx cannot read deployed certificate file {}",
            path.display()
        );
        for (parent, metadata) in inspect_parents(path, &reader)? {
            anyhow::ensure!(
                accessible(&metadata, &reader, true),
                "fnOS Nginx cannot traverse deployed certificate directory {}",
                parent.display()
            );
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn identity(uid: u32, gid: u32) -> Reader {
        Reader {
            uid,
            gid,
            groups: BTreeSet::new(),
        }
    }

    #[test]
    fn deployment_grants_only_worker_group_access_and_preserves_readable_files() {
        let reader = identity(33, 33);
        for (mode, directory, expected) in [(0o100600, false, 0o100640), (0o040700, true, 0o040750)]
        {
            let before = SavedMetadata {
                mode,
                uid: 0,
                gid: 0,
            };
            assert!(!accessible(&before, &reader, directory));
            let after = deployment_metadata(&before, &reader, directory).unwrap();
            assert_eq!(
                after,
                SavedMetadata {
                    mode: expected,
                    uid: 0,
                    gid: 33
                }
            );
            assert!(accessible(&after, &reader, directory));
            assert!(!accessible(&after, &identity(99, 99), directory));
        }
        let readable = SavedMetadata {
            mode: 0o100644,
            uid: 0,
            gid: 0,
        };
        assert_eq!(
            deployment_metadata(&readable, &reader, false).unwrap(),
            readable
        );
        // Owner permissions take priority over otherwise-readable group permissions.
        let owned = SavedMetadata {
            mode: 0o100040,
            uid: 33,
            gid: 33,
        };
        assert!(!accessible(&owned, &reader, false));
        assert!(accessible(
            &deployment_metadata(&owned, &reader, false).unwrap(),
            &reader,
            false
        ));
        assert_eq!(
            parse_identity("Uid:\t0\t33\t33\t33\nGid:\t0\t34\t34\t34\nGroups:\n").unwrap(),
            identity(33, 34)
        );
        assert!(parse_identity("Uid:\t0\nGid:\t0\n").is_err());
    }

    #[test]
    fn filesystem_identity_and_supplementary_groups_preserve_existing_access() {
        let reader =
            parse_identity("Uid: 0 33 33 42\nGid: 0 34 34 37\nGroups: 12 34 12\n").unwrap();
        assert_eq!(reader.uid, 42);
        assert_eq!(reader.gid, 37);
        assert_eq!(reader.groups, BTreeSet::from([12, 34]));
        let metadata = SavedMetadata {
            mode: 0o100640,
            uid: 0,
            gid: 12,
        };
        assert!(accessible(&metadata, &reader, false));
        assert_eq!(
            deployment_metadata(&metadata, &reader, false).unwrap(),
            metadata
        );
        let group_writable = SavedMetadata {
            mode: 0o100620,
            ..metadata.clone()
        };
        assert_eq!(
            deployment_metadata(&group_writable, &reader, false).unwrap(),
            SavedMetadata {
                mode: 0o100660,
                ..metadata.clone()
            }
        );
        let directory = SavedMetadata {
            mode: 0o040710,
            ..metadata.clone()
        };
        assert!(accessible(&directory, &reader, true));
        // Matching group permissions take priority over 'other', even if they deny access.
        assert!(!accessible(
            &SavedMetadata {
                mode: 0o100604,
                ..metadata
            },
            &reader,
            false
        ));
        assert!(parse_identity("Uid: 0 33 33\nGid: 0 34 34\nGroups: 12\n").is_err());
    }

    #[test]
    fn permission_repair_never_displaces_an_existing_groups_access() {
        let reader = identity(33, 33);
        for (mode, directory) in [
            (0o100640, false),
            (0o100620, false),
            (0o040750, true),
            (0o040720, true),
        ] {
            let original = SavedMetadata {
                mode,
                uid: 0,
                gid: 88,
            };
            let error = deployment_metadata(&original, &reader, directory).unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("existing group permissions would be lost")
            );
        }
    }

    #[test]
    fn metadata_only_file_repair_is_recoverable_and_rejects_external_edits() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("fnos-certificate-sync");
        fs::create_dir(&root).unwrap();
        let path = root.join("test-cert");
        fs::write(&path, b"certificate").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let before = SavedMetadata::read(&path).unwrap();
        let after =
            deployment_metadata(&before, &identity(before.uid + 1, before.gid), false).unwrap();
        let mut change = FileChange {
            path: path.to_string_lossy().into(),
            before: Some(BASE64_STANDARD.encode(b"certificate")),
            after: Some(BASE64_STANDARD.encode(b"certificate")),
            original_metadata: Some(before.clone()),
            applied_metadata: Some(after.clone()),
        };
        for _ in 0..2 {
            apply_file(&change, false, dir.path()).unwrap();
        }
        assert_eq!(SavedMetadata::read(&path).unwrap(), after);
        for _ in 0..2 {
            apply_file(&change, true, dir.path()).unwrap();
        }
        assert_eq!(SavedMetadata::read(&path).unwrap(), before);
        // Content replacement must receive the same journaled permissions.
        change.after = Some(BASE64_STANDARD.encode(b"renewed"));
        apply_file(&change, false, dir.path()).unwrap();
        assert_eq!(SavedMetadata::read(&path).unwrap(), after);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            apply_file(&change, true, dir.path())
                .unwrap_err()
                .to_string()
                .contains("permissions changed externally")
        );
        assert_eq!(fs::read(&path).unwrap(), b"renewed");
        after.restore(&path).unwrap();
        apply_file(&change, true, dir.path()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"certificate");
        assert_eq!(SavedMetadata::read(&path).unwrap(), before);
        assert_eq!(fs::metadata(root).unwrap().mode() & 0o777, 0o700);
    }

    #[test]
    fn directory_recovery_accepts_only_recorded_metadata_and_rejects_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deployment");
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let before = directory_metadata(&path).unwrap();
        let after =
            deployment_metadata(&before, &identity(before.uid + 1, before.gid), true).unwrap();
        let change = DirectoryChange {
            path: path.clone(),
            before: before.clone(),
            after: after.clone(),
            created: false,
        };
        check_directory_change(&change).unwrap();
        // Recovery also accepts either interrupted chown/chmod transition, without
        // accepting an unrelated uid/gid or a newly granted world-readable mode.
        let different_group = DirectoryChange {
            after: SavedMetadata {
                gid: before.gid + 1,
                ..after.clone()
            },
            ..change.clone()
        };
        assert!(directory_transition_matches(
            &SavedMetadata {
                gid: different_group.after.gid,
                ..before.clone()
            },
            &different_group
        ));
        assert!(directory_transition_matches(
            &SavedMetadata {
                mode: different_group.after.mode,
                ..before.clone()
            },
            &different_group
        ));
        assert!(!directory_transition_matches(
            &SavedMetadata {
                uid: before.uid + 1,
                ..before.clone()
            },
            &different_group
        ));
        after.restore(&path).unwrap();
        check_directory_change(&change).unwrap();
        before.restore(&path).unwrap();
        check_directory_change(&change).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(check_directory_change(&change).is_err());
        fs::remove_dir(&path).unwrap();
        std::os::unix::fs::symlink(dir.path().join("absent"), &path).unwrap();
        assert!(
            check_directory_change(&DirectoryChange {
                created: true,
                ..change
            })
            .is_err()
        );
        assert!(owned_directory(
            &Path::new(CERT_ROOT).join(format!("fn-knock-{}", Uuid::new_v4()))
        ));
        assert!(!owned_directory(&Path::new(CERT_ROOT).join("fnOS")));
        assert!(!owned_directory(
            &Path::new(CERT_ROOT).join("fn-knock-not-a-uuid")
        ));
    }

    #[test]
    fn unchanged_managed_certificates_are_planned_for_permission_repair() {
        let (mut snapshot, config) = super::super::tests::fixture();
        super::super::tests::managed(&mut snapshot);
        let original = plan_snapshot(snapshot, &config).unwrap();
        let reader = identity(33, 33);
        let inspect = |_: &Path, _: &Reader| {
            Ok((
                SavedMetadata {
                    mode: 0o100600,
                    uid: 0,
                    gid: 0,
                },
                Vec::new(),
            ))
        };
        let mut broken = plan_snapshot(original.snapshot.clone(), &config).unwrap();
        extend_plan_with(&mut broken, &reader, inspect).unwrap();
        assert_eq!(broken.actions[0].kind, "update");
        assert_eq!(broken.actions[0].public["status"], "syncable");
        let mut fixed = plan_snapshot(original.snapshot, &config).unwrap();
        extend_plan_with(&mut fixed, &reader, |_, _| {
            Ok((
                SavedMetadata {
                    mode: 0o100640,
                    uid: 0,
                    gid: 33,
                },
                Vec::new(),
            ))
        })
        .unwrap();
        assert_eq!(fixed.actions[0].kind, "none");
        assert_ne!(broken.version, fixed.version);
        // Ownership conflicts must never become permission repair operations.
        fixed.actions[0].public["status"] = json!("conflict");
        extend_plan_with(&mut fixed, &reader, |_, _| {
            panic!("must not inspect conflicting target")
        })
        .unwrap();
        assert_eq!(fixed.actions[0].kind, "none");
    }

    #[test]
    fn legacy_journals_load_without_new_permission_fields() {
        let change = json!({"path":"/legacy", "before":null,"after":null});
        let journal: Journal = serde_json::from_value(
            json!({"completed":false,"files":[change.clone()],"rows":[],"registry":change}),
        )
        .unwrap();
        assert!(journal.directories.is_empty());
        assert!(journal.files[0].applied_metadata.is_none());
        assert!(journal.files[0].original_metadata.is_none());
    }
}
