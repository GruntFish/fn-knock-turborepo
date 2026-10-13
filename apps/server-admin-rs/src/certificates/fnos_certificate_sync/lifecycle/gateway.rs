//! Recognize only fnOS SNI entries derived from our generated certificate layout.
//! Recognition permits index reconciliation, never unlinking a referenced file.
use super::*;

pub(super) fn derived_mapping(mapping: &Value, row: &Value, index: &[Value]) -> bool {
    if row["is_default"].as_i64() != Some(0)
        || mapping.as_object().is_none_or(|fields| fields.len() != 3)
    {
        return false;
    }
    let Some(certificate) = row["certificate"].as_str() else {
        return false;
    };
    let certificate = Path::new(certificate);
    let Some(directory) = certificate.parent() else {
        return false;
    };
    if directory.parent() != Some(Path::new(CERT_ROOT))
        || directory
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(|s| s.strip_prefix("fn-knock-"))
            .is_none_or(|s| Uuid::parse_str(s).is_err())
        || certificate != directory.join("cert.crt")
        || row["private_key"].as_str().map(Path::new)
            != Some(directory.join("private.key").as_path())
    {
        return false;
    }
    let entries = index
        .iter()
        .filter(|entry| entry["certificate"] == row["certificate"])
        .collect::<Vec<_>>();
    let [entry] = entries.as_slice() else {
        return false;
    };
    if entry["used"] != false
        || entry["appFlag"].as_i64() != Some(0)
        || entry["privateKey"] != row["private_key"]
        || entry["fullchain"].as_str().map(Path::new)
            != Some(directory.join("fullchain.crt").as_path())
        || mapping["cert"] != entry["fullchain"]
        || mapping["key"] != row["private_key"]
    {
        return false;
    }
    let Some(host) = mapping["host"].as_str().filter(|s| *s != "fallback") else {
        return false;
    };
    let Some(san) = entry["san"].as_array() else {
        return false;
    };
    let Some(domains) = san
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    let domains = normalize_domains(domains);
    let row_domains = normalize_domains(split_san(
        row["san"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| row["domain"].as_str().unwrap_or_default()),
    ));
    !domains.is_empty()
        && domains == row_domains
        && domains
            .iter()
            .any(|domain| host == domain.strip_prefix("*.").unwrap_or(domain))
}

fn journal_index(journal: &Journal, before: bool) -> anyhow::Result<Vec<Value>> {
    let file = journal
        .files
        .iter()
        .find(|f| f.path == NETWORK_CERT_INDEX)
        .ok_or_else(|| anyhow!("Missing certificate index recovery record"))?;
    let value = if before { &file.before } else { &file.after };
    Ok(serde_json::from_slice(
        &BASE64_STANDARD.decode(
            value
                .as_ref()
                .ok_or_else(|| anyhow!("Missing certificate index recovery contents"))?,
        )?,
    )?)
}

pub(super) fn reconciled(
    journal: &Journal,
    current: &Snapshot,
    reverse: bool,
) -> anyhow::Result<Vec<Value>> {
    reconcile_plan(journal, current, reverse, journal.gateway_before.as_deref())
}

fn reconcile_plan(
    journal: &Journal,
    current: &Snapshot,
    reverse: bool,
    before: Option<&[Value]>,
) -> anyhow::Result<Vec<Value>> {
    check_removals(journal, current, reverse, true)?;
    let source_index = journal_index(journal, !reverse)?;
    let target_index = journal_index(journal, reverse)?;
    let mut result = current.gateway.clone();
    let mut removed_hosts = BTreeSet::new();
    for change in journal.rows.iter().filter(|r| r.table == "cert") {
        let (source, target) = if reverse {
            (&change.after, &change.before)
        } else {
            (&change.before, &change.after)
        };
        if target.is_some() {
            continue;
        }
        let Some(row) = source else { continue };
        let mut remove = Vec::new();
        for (position, mapping) in result.iter().enumerate() {
            if !derived_mapping(mapping, row, &source_index) {
                continue;
            }
            ensure_unique_host(&result, mapping)?;
            if reverse && journal.gateway_before.is_none() {
                // Old journals lack the previous SNI choice. Never guess which
                // overlapping certificate should replace this newly created one.
                let host = mapping["host"].as_str().unwrap_or_default();
                anyhow::ensure!(
                    !target_index
                        .iter()
                        .any(|entry| entry["san"].as_array().is_some_and(|san| san
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|name| name
                                .strip_prefix("*.")
                                .unwrap_or(name)
                                .eq_ignore_ascii_case(host)))),
                    "Legacy recovery has an overlapping gateway hostname {host}; previous mapping must be confirmed before removal"
                );
            }
            removed_hosts.insert(mapping["host"].clone().to_string());
            remove.push(position);
        }
        for position in remove.into_iter().rev() {
            result.remove(position);
        }
    }
    if reverse && let Some(before) = before {
        let original_paths = journal
            .rows
            .iter()
            .filter(|r| r.table == "cert" && r.after.is_none())
            .filter_map(|r| r.before.as_ref())
            .flat_map(|r| file_paths(r, &target_index))
            .collect::<BTreeSet<_>>();
        // Also covers a retry after the derived mapping was removed but the old
        // mapping was not yet restored. New certificates may shadow existing SANs.
        let new_hosts = journal
            .rows
            .iter()
            .filter(|r| r.table == "cert" && r.before.is_none())
            .filter_map(|r| r.after.as_ref())
            .flat_map(|r| normalize_domains(split_san(r["san"].as_str().unwrap_or_default())))
            .map(|host| host.strip_prefix("*.").unwrap_or(&host).to_owned())
            .collect::<BTreeSet<_>>();
        for mapping in before {
            let relevant = removed_hosts.contains(&mapping["host"].to_string())
                || mapping["host"]
                    .as_str()
                    .is_some_and(|host| new_hosts.contains(host))
                || ["cert", "key"].iter().any(|k| {
                    mapping[k]
                        .as_str()
                        .is_some_and(|path| original_paths.contains(path))
                });
            if !relevant {
                continue;
            }
            ensure_unique_host(before, mapping)?;
            ensure_unique_host(&result, mapping)?;
            if let Some(existing) = result.iter().find(|m| m["host"] == mapping["host"]) {
                anyhow::ensure!(
                    existing == mapping,
                    "Gateway mapping changed externally for {}; recovery backup preserved",
                    mapping["host"]
                );
            } else {
                result.push(mapping.clone());
            }
        }
    }
    Ok(result)
}

fn ensure_unique_host(mappings: &[Value], mapping: &Value) -> anyhow::Result<()> {
    anyhow::ensure!(
        mappings
            .iter()
            .filter(|m| m["host"] == mapping["host"])
            .count()
            <= 1,
        "Ambiguous gateway mappings for {}; recovery backup preserved",
        mapping["host"]
    );
    Ok(())
}

fn backup_path(journal: &Journal, reverse: bool, data_dir: &Path) -> anyhow::Result<PathBuf> {
    Ok(data_dir
        .join("fnos-certificate-sync/gateway-backups")
        .join(format!(
            "{}-{}.json",
            digest(journal)?,
            if reverse { "restore" } else { "apply" }
        )))
}

// The service can generate a mapping after the journal snapshot was taken. The
// durable forward delta records what we actually removed, even across a crash.
fn removed_mappings(journal: &Journal, change: &FileChange) -> anyhow::Result<Vec<Value>> {
    anyhow::ensure!(
        change.path == NETWORK_GATEWAY_INDEX,
        "Invalid gateway recovery path"
    );
    let decode = |value: &Option<String>| -> anyhow::Result<Vec<Value>> {
        Ok(serde_json::from_slice(
            &BASE64_STANDARD.decode(
                value
                    .as_ref()
                    .ok_or_else(|| anyhow!("Missing gateway recovery contents"))?,
            )?,
        )?)
    };
    let before = decode(&change.before)?;
    let after = decode(&change.after)?;
    let index = journal_index(journal, true)?;
    let removed = before
        .iter()
        .filter(|m| !after.contains(m))
        .cloned()
        .collect::<Vec<_>>();
    anyhow::ensure!(
        before
            .iter()
            .filter(|m| !removed.contains(m))
            .cloned()
            .collect::<Vec<_>>()
            == after,
        "Gateway recovery delta contains unexpected additions or changes"
    );
    for mapping in &removed {
        ensure_unique_host(&before, mapping)?;
        anyhow::ensure!(
            journal.rows.iter().any(|r| {
                r.table == "cert"
                    && r.after.is_none()
                    && r.before
                        .as_ref()
                        .is_some_and(|row| derived_mapping(mapping, row, &index))
            }),
            "Gateway recovery delta references an unrelated certificate"
        );
    }
    Ok(removed)
}

pub(super) fn live_plan(
    journal: &Journal,
    current: &Snapshot,
    reverse: bool,
    data_dir: &Path,
) -> anyhow::Result<Vec<Value>> {
    if reverse && let Some(encoded) = read_optional(&backup_path(journal, false, data_dir)?)? {
        let change: FileChange = serde_json::from_slice(&BASE64_STANDARD.decode(encoded)?)?;
        let removed = removed_mappings(journal, &change)?;
        let mut before = journal.gateway_before.clone().unwrap_or_default();
        // The actual removal delta is newer than the initial journal snapshot.
        before.retain(|old| !removed.iter().any(|m| m["host"] == old["host"]));
        before.extend(removed);
        return reconcile_plan(journal, current, reverse, Some(&before));
    }
    reconciled(journal, current, reverse)
}

pub(super) fn reconcile(journal: &Journal, reverse: bool, data_dir: &Path) -> anyhow::Result<()> {
    let current = snapshot(data_dir)?;
    let restored = live_plan(journal, &current, reverse, data_dir)?;
    if restored == current.gateway {
        return Ok(());
    }
    // A previous mapping can refer to a certificate outside the changed rows.
    // Do not resurrect it if that file has since disappeared or become unsafe.
    for mapping in restored.iter().filter(|m| !current.gateway.contains(m)) {
        for key in ["cert", "key"] {
            let path = Path::new(
                mapping[key]
                    .as_str()
                    .ok_or_else(|| anyhow!("Invalid previous gateway mapping"))?,
            );
            validate_target_path(path)?;
            validate_fixed_regular_file(path)?;
        }
    }
    let path = Path::new(NETWORK_GATEWAY_INDEX);
    let before =
        read_optional(path)?.ok_or_else(|| anyhow!("Missing fnOS gateway certificate config"))?;
    let observed: Vec<Value> = serde_json::from_slice(&BASE64_STANDARD.decode(&before)?)?;
    anyhow::ensure!(
        observed == current.gateway,
        "Gateway certificate config changed during recovery planning"
    );
    let change = FileChange {
        path: NETWORK_GATEWAY_INDEX.into(),
        before: Some(before),
        after: Some(BASE64_STANDARD.encode(serde_json::to_vec(&restored)?)),
        original_metadata: Some(SavedMetadata::read(path)?),
        applied_metadata: None,
    };
    // Retain a private, durable copy even for legacy journals with no gateway
    // snapshot. Repeated recovery never overwrites the first copy for this direction.
    let backup = backup_path(journal, reverse, data_dir)?;
    if read_optional(&backup)?.is_none() {
        write_content(&backup, &serde_json::to_vec(&change)?, data_dir)?;
    }
    check_removals(journal, &snapshot(data_dir)?, reverse, true)?;
    apply_file(&change, false, data_dir)
        .context("Reconcile fnOS generated gateway certificate mappings")
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    pub(in super::super) fn fixture() -> (Snapshot, Value) {
        let (mut snapshot, _) = super::super::tests::fixture();
        let dir = format!("{CERT_ROOT}/fn-knock-00000000-0000-0000-0000-000000000001");
        let row = &mut snapshot.rows[0];
        row["certificate"] = json!(format!("{dir}/cert.crt"));
        row["private_key"] = json!(format!("{dir}/private.key"));
        row["issuer_certificate"] = json!(format!("{dir}/issued.crt"));
        let entry = &mut snapshot.index[0];
        entry["certificate"] = row["certificate"].clone();
        entry["privateKey"] = row["private_key"].clone();
        entry["fullchain"] = json!(format!("{dir}/fullchain.crt"));
        let mapping =
            json!({"host":"sync.example.test","cert":entry["fullchain"],"key":entry["privateKey"]});
        snapshot.gateway.push(mapping.clone());
        (snapshot, mapping)
    }

    #[test]
    fn derived_sni_is_not_an_explicit_binding_but_live_flags_always_block() {
        let (snapshot, mapping) = fixture();
        let row = &snapshot.rows[0];
        assert!(derived_mapping(&mapping, row, &snapshot.index));
        assert!(references(&snapshot, row).is_empty());
        for binding in ["default", "service", "used", "appFlag"] {
            let mut current = snapshot.clone();
            match binding {
                "default" => current.rows[0]["is_default"] = json!(1),
                "service" => current.used.push(json!({"cert_id":8,"service_name":"web"})),
                "used" => current.index[0]["used"] = json!(true),
                _ => current.index[0]["appFlag"] = json!(1),
            }
            // Pass the journal's old row: a newly selected default must still be noticed.
            assert!(!references(&current, row).is_empty(), "{binding}");
        }
    }

    #[test]
    fn unknown_external_and_fallback_mappings_are_never_exempted() {
        let (snapshot, mapping) = fixture();
        for (field, value) in [
            ("host", json!("fallback")),
            ("host", json!("outside.example.test")),
            ("cert", json!("/outside")),
            ("key", json!("/other-key")),
            ("unknown", json!(true)),
        ] {
            let mut changed = mapping.clone();
            changed[field] = value;
            assert!(
                !derived_mapping(&changed, &snapshot.rows[0], &snapshot.index),
                "{field}"
            );
        }
        let mut duplicate = snapshot.index.clone();
        duplicate.push(duplicate[0].clone());
        assert!(!derived_mapping(&mapping, &snapshot.rows[0], &duplicate));
        let mut changed = snapshot.index.clone();
        changed[0]["san"] = json!(["another.example.test"]);
        assert!(!derived_mapping(&mapping, &snapshot.rows[0], &changed));
    }

    #[test]
    fn legacy_recovery_may_refresh_derived_maps_but_must_not_unlink_them() {
        let (mut current, mapping) = fixture();
        let (mut journal, _) = super::super::tests::batch_removal_fixture(true);
        journal.rows.truncate(1);
        journal.rows[0].after = Some(current.rows[0].clone());
        let index = journal
            .files
            .iter_mut()
            .find(|f| f.path == NETWORK_CERT_INDEX)
            .unwrap();
        index.after = Some(BASE64_STANDARD.encode(serde_json::to_vec(&current.index).unwrap()));
        check_removals(&journal, &current, true, true).unwrap();
        assert!(ensure_removals_unreferenced(&journal, &current, true).is_err());
        // Interrupted recovery already restored DB/index, but not service config.
        current.rows.clear();
        current.index.clear();
        check_removals(&journal, &current, true, true).unwrap();
        assert!(ensure_removals_unreferenced(&journal, &current, true).is_err());
        current.gateway.clear();
        ensure_removals_unreferenced(&journal, &current, true).unwrap();
        let mut external = mapping;
        external["host"] = json!("external.example.test");
        current.gateway.push(external);
        assert!(check_removals(&journal, &current, true, true).is_err());
    }

    #[test]
    fn reconciliation_preserves_unrelated_maps_and_restores_previous_choice() {
        let (mut current, mapping) = fixture();
        let (mut journal, _) = super::super::tests::batch_removal_fixture(true);
        journal.rows.truncate(1);
        journal.rows[0].after = Some(current.rows[0].clone());
        let unrelated = json!({"host":"fallback","cert":"/system-cert","key":"/system-key"});
        let previous =
            json!({"host":"sync.example.test","cert":"/previous-cert","key":"/previous-key"});
        journal.gateway_before = Some(vec![unrelated.clone(), previous.clone()]);
        journal
            .files
            .iter_mut()
            .find(|f| f.path == NETWORK_CERT_INDEX)
            .unwrap()
            .after = Some(BASE64_STANDARD.encode(serde_json::to_vec(&current.index).unwrap()));
        current.gateway.push(unrelated.clone());
        current.rows.clear();
        current.index.clear();
        let restored = reconciled(&journal, &current, true).unwrap();
        assert_eq!(restored, vec![unrelated.clone(), previous.clone()]);
        current.gateway = restored;
        assert_eq!(
            reconciled(&journal, &current, true).unwrap(),
            current.gateway
        );
        current.gateway[1]["key"] = json!("/external-key");
        assert!(reconciled(&journal, &current, true).is_err());
        // Legacy journals must not guess the previous certificate for an overlapping SAN.
        journal.gateway_before = None;
        let old_index = json!([{"certificate":"/previous-cert","san":["sync.example.test"]}]);
        journal
            .files
            .iter_mut()
            .find(|f| f.path == NETWORK_CERT_INDEX)
            .unwrap()
            .before = Some(BASE64_STANDARD.encode(serde_json::to_vec(&old_index).unwrap()));
        current.gateway = vec![mapping, unrelated];
        assert!(reconciled(&journal, &current, true).is_err());
    }

    #[test]
    fn updating_certificate_contents_does_not_revert_unrelated_mapping_edits() {
        let (mut current, mapping) = fixture();
        let (mut journal, _) = super::super::tests::batch_removal_fixture(true);
        journal.rows.truncate(1);
        journal.rows[0].before = Some(current.rows[0].clone());
        journal.rows[0].after = Some(current.rows[0].clone());
        journal.gateway_before = Some(vec![mapping]);
        current.gateway.clear(); // An administrator independently removed this host.
        assert!(reconciled(&journal, &current, true).unwrap().is_empty());
    }

    #[test]
    fn forward_removal_backup_restores_maps_generated_after_journal_snapshot() {
        let (mut current, mapping) = fixture();
        let (mut journal, _) = super::super::tests::batch_removal_fixture(false);
        journal.rows.truncate(1);
        journal.rows[0].before = Some(current.rows[0].clone());
        journal.gateway_before = Some(vec![]); // fnOS has not generated this host yet.
        journal
            .files
            .iter_mut()
            .find(|f| f.path == NETWORK_CERT_INDEX)
            .unwrap()
            .before = Some(BASE64_STANDARD.encode(serde_json::to_vec(&current.index).unwrap()));
        let unrelated = json!({"host":"fallback","cert":"/system-cert","key":"/system-key"});
        current.gateway.push(unrelated.clone());
        let after = reconciled(&journal, &current, false).unwrap();
        assert_eq!(after, vec![unrelated.clone()]);
        let change = FileChange {
            path: NETWORK_GATEWAY_INDEX.into(),
            before: Some(BASE64_STANDARD.encode(serde_json::to_vec(&current.gateway).unwrap())),
            after: Some(BASE64_STANDARD.encode(serde_json::to_vec(&after).unwrap())),
            original_metadata: None,
            applied_metadata: None,
        };
        let dir = tempfile::tempdir().unwrap();
        write_content(
            &backup_path(&journal, false, dir.path()).unwrap(),
            &serde_json::to_vec(&change).unwrap(),
            dir.path(),
        )
        .unwrap();
        // Rollback has restored the row and certificate index; the removed map
        // must survive both process restart and repeated recovery planning.
        current.gateway = after;
        let restored = live_plan(&journal, &current, true, dir.path()).unwrap();
        assert_eq!(restored, vec![unrelated, mapping]);
        current.gateway = restored;
        assert_eq!(
            live_plan(&journal, &current, true, dir.path()).unwrap(),
            current.gateway
        );
        current.gateway[1]["key"] = json!("/externally-selected-key");
        assert!(live_plan(&journal, &current, true, dir.path()).is_err());
        let mut invalid = change.clone();
        invalid.after = Some(BASE64_STANDARD.encode(b"[]")); // Also removes fallback.
        assert!(removed_mappings(&journal, &invalid).is_err());
        invalid = change.clone();
        invalid.after = invalid.before.clone();
        invalid.before = change.after.clone(); // Backup must never describe additions.
        assert!(removed_mappings(&journal, &invalid).is_err());
    }

    #[test]
    fn duplicate_hosts_block_removal_and_restoration_regardless_of_entry_order() {
        let (mut current, mapping) = fixture();
        let (mut journal, _) = super::super::tests::batch_removal_fixture(true);
        journal.rows.truncate(1);
        journal.rows[0].after = Some(current.rows[0].clone());
        journal
            .files
            .iter_mut()
            .find(|f| f.path == NETWORK_CERT_INDEX)
            .unwrap()
            .after = Some(BASE64_STANDARD.encode(serde_json::to_vec(&current.index).unwrap()));
        let previous = json!({"host":"sync.example.test","cert":"/previous","key":"/previous-key"});
        journal.gateway_before = Some(vec![previous.clone()]);
        let mut competing = previous.clone();
        competing["key"] = json!("/competing-key");
        for mappings in [
            vec![mapping.clone(), previous.clone()],
            vec![previous.clone(), mapping.clone()],
            vec![mapping.clone(), mapping],
            vec![previous.clone(), competing.clone()],
            vec![competing, previous.clone()],
            vec![previous.clone(), previous],
        ] {
            current.gateway = mappings;
            assert!(reconciled(&journal, &current, true).is_err());
        }
    }

    #[test]
    fn generated_index_reformatting_is_safe_but_field_changes_are_not() {
        let encoded = |v: &str| Some(BASE64_STANDARD.encode(v));
        let old = encoded(r#"[{"certificate":"/a","used":false,"appFlag":0}]"#);
        let reformatted =
            encoded("[ { \"appFlag\": 0, \"used\": false, \"certificate\": \"/a\" } ]\n");
        assert!(file_content_matches(NETWORK_CERT_INDEX, &old, &reformatted));
        assert!(!file_content_matches("/certificate", &old, &reformatted));
        let changed = encoded(r#"[{"certificate":"/a","used":true,"appFlag":0}]"#);
        assert!(!file_content_matches(NETWORK_CERT_INDEX, &old, &changed));
        assert!(!file_content_matches(NETWORK_CERT_INDEX, &old, &None));
    }
}
