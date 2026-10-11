use super::{CERT_ROOT, NETWORK_CERT_INDEX};
#[cfg(target_os = "linux")]
use anyhow::Context;
use std::path::Path;

// mode/uid/gid journals cannot reproduce named/default POSIX ACL entries. Refuse
// to replace such files rather than drop access rules or widen an inherited ACL mask.
#[cfg(target_os = "linux")]
pub(super) fn reject_extended_acl(path: &Path) -> anyhow::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let native = CString::new(path.as_os_str().as_bytes())?;
    for name in [c"system.posix_acl_access", c"system.posix_acl_default"] {
        // SAFETY: both names are NUL-terminated; a null value with length zero queries size.
        let size =
            unsafe { libc::lgetxattr(native.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0) };
        if size >= 0 {
            anyhow::ensure!(
                size == 0,
                "Certificate path {} has a POSIX ACL that cannot be safely journaled; ACL-aware handling is required",
                path.display()
            );
        } else {
            let error = std::io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(libc::ENODATA | libc::ENOTSUP | libc::ENOENT)
            ) {
                return Err(error)
                    .with_context(|| format!("Inspect certificate ACL at {}", path.display()));
            }
        }
    }
    Ok(())
}
#[cfg(not(target_os = "linux"))]
pub(super) fn reject_extended_acl(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

pub(in super::super) fn check_path_access_rules(path: &Path) -> anyhow::Result<()> {
    if !path.starts_with(CERT_ROOT) && path != Path::new(NETWORK_CERT_INDEX) {
        return Ok(());
    }
    reject_extended_acl(path)?;
    for parent in path.ancestors().skip(1) {
        reject_extended_acl(parent)?;
    }
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{ffi::CString, fs, os::unix::ffi::OsStrExt};

    fn install_acl(path: &Path, default: bool) {
        // Linux POSIX ACL xattr v2: owner, named user, owning group, mask, other.
        let mut value = 2u32.to_le_bytes().to_vec();
        for (tag, permissions, id) in [
            (1u16, 6u16, u32::MAX),
            (2, 4, 424242),
            (4, 0, u32::MAX),
            (16, 4, u32::MAX),
            (32, 0, u32::MAX),
        ] {
            value.extend(tag.to_le_bytes());
            value.extend(permissions.to_le_bytes());
            value.extend(id.to_le_bytes());
        }
        let path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let name = if default {
            c"system.posix_acl_default"
        } else {
            c"system.posix_acl_access"
        };
        // SAFETY: all pointers refer to valid buffers for the supplied lengths.
        let result = unsafe {
            libc::lsetxattr(
                path.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
            )
        };
        assert_eq!(result, 0, "{}", std::io::Error::last_os_error());
    }

    #[test]
    fn linux_named_and_default_acls_are_rejected_before_permission_changes() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("synthetic-certificate");
        fs::write(&file, b"synthetic data").unwrap();
        reject_extended_acl(&file).unwrap();
        reject_extended_acl(&temp.path().join("new-certificate")).unwrap();
        install_acl(&file, false);
        let error = reject_extended_acl(&file).unwrap_err();
        assert!(error.to_string().contains("POSIX ACL"));
        assert_eq!(fs::read(&file).unwrap(), b"synthetic data");
        install_acl(temp.path(), true);
        assert!(
            reject_extended_acl(temp.path())
                .unwrap_err()
                .to_string()
                .contains("POSIX ACL")
        );
    }
}
