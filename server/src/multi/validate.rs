//! Whole-config validation for multi-space mode. Pure — filesystem checks
//! (folder accessibility) happen in the manager at apply time.

use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use crate::multi::config::{Binding, MultiConfig};

#[derive(Debug, Clone, Serialize)]
pub struct FieldError {
    pub field: String,
    pub message: String,
}

fn err(errors: &mut Vec<FieldError>, field: impl Into<String>, message: impl Into<String>) {
    errors.push(FieldError {
        field: field.into(),
        message: message.into(),
    });
}

/// Normalize a URL prefix: single leading `/`, no trailing `/`; `/` -> "".
/// Mirrors the single-space `SB_URL_PREFIX` normalization.
pub fn normalize_prefix(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let with_lead = if raw.starts_with('/') {
        raw.to_string()
    } else {
        format!("/{raw}")
    };
    with_lead.trim_end_matches('/').to_string()
}

/// Validate the whole config. Empty result = acceptable. Field paths are
/// `<space-id>.<jsonField>`.
pub fn validate(
    config: &MultiConfig,
    root: &Path,
    known_users: &BTreeSet<String>,
) -> Vec<FieldError> {
    let mut errors = Vec::new();
    let mut seen_prefixes: HashMap<String, String> = HashMap::new(); // normalized -> id
    let mut seen_hosts: HashMap<String, String> = HashMap::new();

    for (id, space) in &config.spaces {
        if space.extra.contains_key("auth") {
            err(
                &mut errors,
                format!("{id}.auth"),
                "unknown field (use access/members for access)",
            );
        }
        if space.name.trim().is_empty() {
            err(&mut errors, format!("{id}.name"), "name must not be empty");
        }
        match &space.binding {
            Binding::Prefix { prefix } => {
                let norm = normalize_prefix(prefix);
                if norm.starts_with("/.") {
                    err(
                        &mut errors,
                        format!("{id}.binding"),
                        "prefixes starting with /. are reserved",
                    );
                } else {
                    // Nested prefixes overlap routes and service-worker scopes. The empty
                    // root prefix conflicts only with another root; treating it as a normal
                    // prefix would incorrectly reject every other binding.
                    let conflict = seen_prefixes.iter().find(|(other_norm, _)| {
                        *other_norm == &norm
                            || (!norm.is_empty()
                                && !other_norm.is_empty()
                                && (norm.starts_with(&format!("{other_norm}/"))
                                    || other_norm.starts_with(&format!("{norm}/"))))
                    });
                    if let Some((other_norm, other_id)) = conflict {
                        let other_name = config
                            .spaces
                            .get(other_id)
                            .map(|s| s.name.clone())
                            .unwrap_or_else(|| other_id.clone());
                        err(
                            &mut errors,
                            format!("{id}.binding"),
                            format!(
                                "prefix {norm:?} overlaps prefix {other_norm:?} of space \"{other_name}\""
                            ),
                        );
                    } else {
                        seen_prefixes.insert(norm, id.clone());
                    }
                }
            }
            Binding::Host { host } => {
                if host.is_empty() || host.contains('/') || host.contains(':') {
                    err(
                        &mut errors,
                        format!("{id}.binding"),
                        "host must be a bare hostname (no port, no slashes)",
                    );
                } else if host
                    .trim_end_matches('.')
                    .to_ascii_lowercase()
                    .ends_with(".runtime.localhost")
                {
                    err(
                        &mut errors,
                        format!("{id}.binding"),
                        "hosts ending in .runtime.localhost are reserved for the Runtime API",
                    );
                } else if let Some(other) = seen_hosts.insert(host.to_ascii_lowercase(), id.clone())
                {
                    err(
                        &mut errors,
                        format!("{id}.binding"),
                        format!("host {host:?} already used by space {other}"),
                    );
                }
            }
        }
        for (member, entry) in &space.members {
            if entry.runtime_api && entry.role != super::config::MemberRole::Write {
                err(
                    &mut errors,
                    format!("{id}.members.{member}.runtimeApi"),
                    "runtime API requires Write access",
                );
            }
            if !known_users.contains(member) {
                err(
                    &mut errors,
                    format!("{id}.members"),
                    format!("unknown user {member:?}"),
                );
            }
        }
        if !space.git_sync().mode.is_off()
            && space.revisions != silverbullet_server_common::RevisionsMode::Managed
        {
            err(
                &mut errors,
                format!("{id}.gitSync"),
                "git sync requires managed revisions; remove the Git connection before disabling automatic revisions",
            );
        }
    }

    // Resolved folders must not nest or collide. Resolution mirrors
    // instance::resolve_folder (empty -> spaces/<id>). Collected after the
    // per-space loop and compared pairwise since nesting is order-independent.
    let resolved: Vec<(String, PathBuf)> = config
        .spaces
        .iter()
        .map(|(id, s)| {
            (
                id.clone(),
                crate::multi::instance::resolve_folder(root, id, &s.folder),
            )
        })
        .collect();
    for (i, (id_a, a)) in resolved.iter().enumerate() {
        for (id_b, b) in resolved.iter().skip(i + 1) {
            if a == b || a.starts_with(b) || b.starts_with(a) {
                err(
                    &mut errors,
                    format!("{id_a}.folder"),
                    format!(
                        "folder overlaps with the folder of space {id_b} — space folders may not nest"
                    ),
                );
            }
        }
    }

    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::multi::config::{Binding, MultiConfig, SpaceAccess, SpaceConfig};

    fn space(name: &str, binding: Binding) -> SpaceConfig {
        SpaceConfig {
            name: name.into(),
            folder: String::new(),
            binding,
            access: Some(SpaceAccess::Write),
            legacy_public: None,
            members: Default::default(),
            read_only: false,
            shell: Default::default(),
            index_page: "index".into(),
            description: String::new(),
            theme_color: "#e1e1e1".into(),
            head_html: String::new(),
            space_ignore: String::new(),
            log_push: false,
            revisions: Default::default(),
            git_sync: None,
            revisions_commit: None,
            extra: Default::default(),
        }
    }

    fn cfg(entries: Vec<(&str, SpaceConfig)>) -> MultiConfig {
        MultiConfig {
            spaces: entries
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        }
    }

    fn users(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn prefix_normalization_rules() {
        assert_eq!(normalize_prefix("/"), "");
        assert_eq!(normalize_prefix("wiki"), "/wiki");
        assert_eq!(normalize_prefix("/wiki/"), "/wiki");
    }

    #[test]
    fn valid_config_passes() {
        let dir = tempfile::tempdir().unwrap();
        let c = cfg(vec![
            (
                "a",
                space(
                    "A",
                    Binding::Prefix {
                        prefix: "/a".into(),
                    },
                ),
            ),
            (
                "b",
                space(
                    "B",
                    Binding::Host {
                        host: "b.example.com".into(),
                    },
                ),
            ),
        ]);
        assert!(validate(&c, dir.path(), &users(&[])).is_empty());
    }

    #[test]
    fn root_prefix_is_allowed_once_and_coexists() {
        let dir = tempfile::tempdir().unwrap();
        let c = cfg(vec![
            ("r", space("Root", Binding::Prefix { prefix: "/".into() })),
            (
                "w",
                space(
                    "Work",
                    Binding::Prefix {
                        prefix: "/work".into(),
                    },
                ),
            ),
        ]);
        assert!(validate(&c, dir.path(), &users(&[])).is_empty());
        let c = cfg(vec![
            ("a", space("A", Binding::Prefix { prefix: "/".into() })),
            ("b", space("B", Binding::Prefix { prefix: "".into() })),
        ]);
        let errs = validate(&c, dir.path(), &users(&[]));
        assert!(
            errs.iter().any(|e| e.field.ends_with(".binding")),
            "{errs:?}"
        );
    }

    #[test]
    fn overlapping_prefixes_rejected() {
        let dir = tempfile::tempdir().unwrap();
        for (p1, p2) in [("/work", "/work/sub"), ("/work/sub", "/work")] {
            let c = cfg(vec![
                ("a", space("A", Binding::Prefix { prefix: p1.into() })),
                ("b", space("B", Binding::Prefix { prefix: p2.into() })),
            ]);
            let errs = validate(&c, dir.path(), &users(&[]));
            assert!(
                errs.iter().any(|e| e.field.ends_with(".binding")),
                "{p1} + {p2} must conflict: {errs:?}"
            );
        }
        let c = cfg(vec![
            (
                "a",
                space(
                    "A",
                    Binding::Prefix {
                        prefix: "/work".into(),
                    },
                ),
            ),
            (
                "b",
                space(
                    "B",
                    Binding::Prefix {
                        prefix: "/workshop".into(),
                    },
                ),
            ),
        ]);
        assert!(validate(&c, dir.path(), &users(&[])).is_empty());
    }

    #[test]
    fn nested_folders_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = space(
            "A",
            Binding::Prefix {
                prefix: "/a".into(),
            },
        );
        a.folder = ".".into(); // the data root itself
        let mut b = space(
            "B",
            Binding::Prefix {
                prefix: "/b".into(),
            },
        );
        b.folder = "spaces/b".into(); // nested inside the data root
        let errs = validate(&cfg(vec![("a", a), ("b", b)]), dir.path(), &users(&[]));
        assert!(
            errs.iter().any(|e| e.field.ends_with(".folder")),
            "{errs:?}"
        );
        let mut a = space(
            "A",
            Binding::Prefix {
                prefix: "/a".into(),
            },
        );
        a.folder = "spaces/a".into();
        let mut b = space(
            "B",
            Binding::Prefix {
                prefix: "/b".into(),
            },
        );
        b.folder = "spaces/b".into();
        assert!(validate(&cfg(vec![("a", a), ("b", b)]), dir.path(), &users(&[])).is_empty());
    }

    #[test]
    fn duplicate_folders_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = space(
            "A",
            Binding::Prefix {
                prefix: "/a".into(),
            },
        );
        a.folder = "spaces/notes".into();
        let mut b = space(
            "B",
            Binding::Prefix {
                prefix: "/b".into(),
            },
        );
        b.folder = "spaces/notes/".into(); // same after trailing-slash trim
        let errs = validate(&cfg(vec![("a", a), ("b", b)]), dir.path(), &users(&[]));
        assert!(
            errs.iter().any(|e| e.field.ends_with(".folder")),
            "{errs:?}"
        );
        let c = cfg(vec![
            (
                "a",
                space(
                    "A",
                    Binding::Prefix {
                        prefix: "/a".into(),
                    },
                ),
            ),
            (
                "b",
                space(
                    "B",
                    Binding::Prefix {
                        prefix: "/b".into(),
                    },
                ),
            ),
        ]);
        assert!(validate(&c, dir.path(), &users(&[])).is_empty());
    }

    #[test]
    fn duplicate_bindings_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let c = cfg(vec![
            (
                "a",
                space(
                    "A",
                    Binding::Prefix {
                        prefix: "/x".into(),
                    },
                ),
            ),
            (
                "b",
                space(
                    "B",
                    Binding::Prefix {
                        prefix: "/x/".into(),
                    },
                ),
            ), // same after normalization
        ]);
        let errs = validate(&c, dir.path(), &users(&[]));
        assert!(
            errs.iter().any(|e| e.field.ends_with(".binding")),
            "{errs:?}"
        );
    }

    #[test]
    fn duplicate_hosts_rejected_case_insensitively() {
        let dir = tempfile::tempdir().unwrap();
        let c = cfg(vec![
            (
                "a",
                space(
                    "A",
                    Binding::Host {
                        host: "Notes.Example.com".into(),
                    },
                ),
            ),
            (
                "b",
                space(
                    "B",
                    Binding::Host {
                        host: "notes.example.COM".into(),
                    },
                ),
            ),
        ]);
        let errs = validate(&c, dir.path(), &users(&[]));
        assert!(
            errs.iter().any(|e| e.field.ends_with(".binding")),
            "{errs:?}"
        );
    }

    #[test]
    fn runtime_localhost_bindings_are_reserved() {
        let dir = tempfile::tempdir().unwrap();
        for host in [
            "notes.runtime.localhost",
            "NOTES.RUNTIME.LOCALHOST.",
            "notes.runtime.localhost..",
        ] {
            let c = cfg(vec![(
                "a",
                space("Notes", Binding::Host { host: host.into() }),
            )]);
            let errors = validate(&c, dir.path(), &users(&[]));
            assert!(
                errors
                    .iter()
                    .any(|error| error.field == "a.binding" && error.message.contains("reserved")),
                "{host}: {errors:?}"
            );
        }
    }

    #[test]
    fn reserved_bindings_and_invalid_hosts_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let c = cfg(vec![
            (
                "a",
                space(
                    "A",
                    Binding::Prefix {
                        prefix: "/.spaces".into(),
                    },
                ),
            ),
            (
                "b",
                space(
                    "B",
                    Binding::Host {
                        host: "with/slash".into(),
                    },
                ),
            ),
        ]);
        let errs = validate(&c, dir.path(), &users(&[]));
        assert_eq!(errs.len(), 2, "{errs:?}");
    }

    #[test]
    fn unknown_member_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = space(
            "A",
            Binding::Prefix {
                prefix: "/a".into(),
            },
        );
        s.members.insert("ghost".into(), Default::default());
        let errs = validate(&cfg(vec![("a", s.clone())]), dir.path(), &users(&[]));
        assert!(
            errs.iter().any(|e| e.field.ends_with(".members")),
            "{errs:?}"
        );
        assert!(validate(&cfg(vec![("a", s)]), dir.path(), &users(&["ghost"])).is_empty());
    }

    #[test]
    fn empty_name_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let s = space(
            "",
            Binding::Prefix {
                prefix: "/a".into(),
            },
        );
        let errs = validate(&cfg(vec![("a", s)]), dir.path(), &users(&[]));
        assert!(errs.iter().any(|e| e.field == "a.name"), "{errs:?}");
    }

    #[test]
    fn git_sync_requires_managed_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = space(
            "A",
            Binding::Prefix {
                prefix: "/a".into(),
            },
        );
        s.revisions = silverbullet_server_common::RevisionsMode::Unmanaged;
        s.git_sync = Some(crate::multi::config::GitSyncConfig {
            paused: false,
            mode: crate::multi::config::GitSyncMode::Key,
            pull_interval_secs: 300,
        });

        let errs = validate(&cfg(vec![("a", s)]), dir.path(), &users(&[]));
        assert!(
            errs.iter().any(|e| e.field == "a.gitSync"),
            "expected a gitSync error, got {errs:?}"
        );
    }

    /// Manual mode is just as much "on" as key mode -- it is the credential
    /// story that differs, not whether the space touches a remote.
    #[test]
    fn manual_git_sync_also_requires_managed_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = space(
            "A",
            Binding::Prefix {
                prefix: "/a".into(),
            },
        );
        s.revisions = silverbullet_server_common::RevisionsMode::Unmanaged;
        s.git_sync = Some(crate::multi::config::GitSyncConfig {
            paused: false,
            mode: crate::multi::config::GitSyncMode::Manual,
            pull_interval_secs: 300,
        });

        let errs = validate(&cfg(vec![("a", s)]), dir.path(), &users(&[]));
        assert!(
            errs.iter().any(|e| e.field == "a.gitSync"),
            "expected a gitSync error, got {errs:?}"
        );
    }

    #[test]
    fn git_sync_off_on_unmanaged_revisions_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = space(
            "A",
            Binding::Prefix {
                prefix: "/a".into(),
            },
        );
        s.revisions = silverbullet_server_common::RevisionsMode::Unmanaged;
        s.git_sync = Some(crate::multi::config::GitSyncConfig {
            paused: false,
            mode: crate::multi::config::GitSyncMode::Off,
            pull_interval_secs: 300,
        });

        let errs = validate(&cfg(vec![("a", s)]), dir.path(), &users(&[]));
        assert!(
            !errs.iter().any(|e| e.field == "a.gitSync"),
            "expected no gitSync error, got {errs:?}"
        );
    }
}
