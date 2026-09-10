use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use silverbullet_server_common::revision::sha256_hex;

const MAX_ENTRIES: usize = 1_000;
const MAX_ENTRY_BYTES: usize = 64 * 1024;
const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct History {
    entries: Vec<String>,
    entry_json_sizes: Vec<usize>,
    path: Option<PathBuf>,
}

impl History {
    pub fn load(base_url: &str) -> Result<Self, String> {
        Self::load_from(base_url, &crate::config::config_dir())
    }

    pub fn entries(&self) -> &[String] {
        &self.entries
    }

    pub fn push(&mut self, code: &str) -> Result<(), String> {
        if code.len() > MAX_ENTRY_BYTES {
            return Err(format!(
                "REPL history entry is too large (maximum {MAX_ENTRY_BYTES} bytes)"
            ));
        }

        for index in (0..self.entries.len()).rev() {
            if self.entries[index] == code {
                self.entries.remove(index);
                self.entry_json_sizes.remove(index);
            }
        }
        self.entries.push(code.to_owned());
        self.entry_json_sizes.push(json_string_size(code)?);
        if self.entries.len() > MAX_ENTRIES {
            let excess = self.entries.len() - MAX_ENTRIES;
            self.entries.drain(..excess);
            self.entry_json_sizes.drain(..excess);
        }
        let mut drop_count = 0;
        let mut serialized_len = history_json_size(&self.entry_json_sizes);
        while serialized_len > MAX_HISTORY_BYTES {
            serialized_len -= self.entry_json_sizes[drop_count] + 1;
            drop_count += 1;
        }
        if drop_count > 0 {
            self.entries.drain(..drop_count);
            self.entry_json_sizes.drain(..drop_count);
        }

        if let Some(path) = &self.path {
            write_history(path, &self.entries)?;
        }
        Ok(())
    }

    fn load_from(base_url: &str, config_dir: &Path) -> Result<Self, String> {
        let path = history_path(base_url, config_dir);
        let file = match std::fs::File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self {
                    entries: Vec::new(),
                    entry_json_sizes: Vec::new(),
                    path: Some(path),
                });
            }
            Err(error) => {
                return Err(format!("reading REPL history {}: {error}", path.display()));
            }
        };
        let mut data = Vec::new();
        file.take((MAX_HISTORY_BYTES + 1) as u64)
            .read_to_end(&mut data)
            .map_err(|error| format!("reading REPL history {}: {error}", path.display()))?;
        if data.len() > MAX_HISTORY_BYTES {
            return Err(format!(
                "reading REPL history {}: exceeds {MAX_HISTORY_BYTES} bytes",
                path.display()
            ));
        }
        let entries: Vec<String> = serde_json::from_slice(&data)
            .map_err(|error| format!("parsing REPL history {}: {error}", path.display()))?;
        if entries.len() > MAX_ENTRIES {
            return Err(format!(
                "parsing REPL history {}: contains more than {MAX_ENTRIES} entries",
                path.display()
            ));
        }
        if entries.iter().any(|entry| entry.len() > MAX_ENTRY_BYTES) {
            return Err(format!(
                "parsing REPL history {}: contains an entry larger than {MAX_ENTRY_BYTES} bytes",
                path.display()
            ));
        }
        let entry_json_sizes = entries
            .iter()
            .map(|entry| json_string_size(entry))
            .collect::<Result<_, _>>()?;
        Ok(Self {
            entries,
            entry_json_sizes,
            path: Some(path),
        })
    }
}

fn json_string_size(value: &str) -> Result<usize, String> {
    serde_json::to_vec(value)
        .map(|encoded| encoded.len())
        .map_err(|error| format!("serializing REPL history entry: {error}"))
}

fn history_json_size(entry_sizes: &[usize]) -> usize {
    if entry_sizes.is_empty() {
        2
    } else {
        entry_sizes.iter().sum::<usize>() + entry_sizes.len() + 1
    }
}

fn history_path(base_url: &str, config_dir: &Path) -> PathBuf {
    config_dir
        .join("repl-history")
        .join(format!("{}.json", sha256_hex(base_url.as_bytes())))
}

fn write_history(path: &Path, entries: &[String]) -> Result<(), String> {
    let dir = path.parent().expect("history path has a parent");
    create_private_dir(dir)?;
    let data = serde_json::to_vec(entries)
        .map_err(|error| format!("serializing REPL history: {error}"))?;
    if data.len() > MAX_HISTORY_BYTES {
        return Err(format!(
            "serialized REPL history exceeds {MAX_HISTORY_BYTES} bytes"
        ));
    }

    let mut file = tempfile::NamedTempFile::new_in(dir)
        .map_err(|error| format!("creating temporary REPL history: {error}"))?;
    set_private_file_permissions(file.path())?;
    file.write_all(&data)
        .map_err(|error| format!("writing temporary REPL history: {error}"))?;
    file.persist(path).map_err(|error| {
        format!(
            "persisting REPL history {}: {}",
            path.display(),
            error.error
        )
    })?;
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(|error| {
                format!(
                    "creating REPL history directory {}: {error}",
                    path.display()
                )
            })?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!(
                "setting REPL history directory permissions {}: {error}",
                path.display()
            )
        })
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(path).map_err(|error| {
            format!(
                "creating REPL history directory {}: {error}",
                path.display()
            )
        })
    }
}

fn set_private_file_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|error| {
            format!(
                "setting REPL history file permissions {}: {error}",
                path.display()
            )
        })
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_entries_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let mut history = History::load_from("https://notes.example.test", dir.path()).unwrap();

        history.push("return 1").unwrap();
        history.push("return 2").unwrap();

        let reloaded = History::load_from("https://notes.example.test", dir.path()).unwrap();
        assert_eq!(reloaded.entries(), &["return 1", "return 2"]);
    }

    #[test]
    fn separates_targets_without_putting_urls_in_file_names() {
        let dir = tempfile::tempdir().unwrap();
        let mut first =
            History::load_from("https://reader:secret@one.example.test", dir.path()).unwrap();
        first.push("return 'first'").unwrap();

        let second = History::load_from("https://two.example.test", dir.path()).unwrap();
        assert!(second.entries().is_empty());

        let names = std::fs::read_dir(dir.path().join("repl-history"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 1);
        assert!(!names[0].contains("reader"));
        assert!(!names[0].contains("secret"));
        assert!(!names[0].contains("one.example.test"));
    }

    #[test]
    fn repeated_entry_moves_to_newest_position() {
        let dir = tempfile::tempdir().unwrap();
        let mut history = History::load_from("https://notes.example.test", dir.path()).unwrap();
        history.push("return 1").unwrap();
        history.push("return 2").unwrap();

        history.push("return 1").unwrap();

        assert_eq!(history.entries(), &["return 2", "return 1"]);
    }

    #[test]
    fn bounds_entry_count_and_rejects_oversized_entries() {
        let mut history = History::default();
        for index in 0..=MAX_ENTRIES {
            history.push(&format!("return {index}")).unwrap();
        }

        assert_eq!(history.entries().len(), MAX_ENTRIES);
        assert_eq!(history.entries().first().unwrap(), "return 1");
        assert!(history.push(&"x".repeat(MAX_ENTRY_BYTES + 1)).is_err());
        assert_eq!(history.entries().len(), MAX_ENTRIES);
    }

    #[test]
    fn bounds_total_serialized_size_by_discarding_oldest_entries() {
        let mut history = History::default();
        for index in 0..130 {
            let prefix = format!("{index:03}");
            let entry = prefix + &"x".repeat(MAX_ENTRY_BYTES - 3);
            history.push(&entry).unwrap();
        }

        assert!(history_json_size(&history.entry_json_sizes) <= MAX_HISTORY_BYTES);
        assert!(history.entries().len() < 130);
        assert!(history.entries().last().unwrap().starts_with("129"));
    }

    #[test]
    fn refuses_to_read_a_history_file_over_the_total_limit() {
        let dir = tempfile::tempdir().unwrap();
        let history_dir = dir.path().join("repl-history");
        std::fs::create_dir_all(&history_dir).unwrap();
        let path = history_path("https://notes.example.test", dir.path());
        std::fs::write(&path, vec![b' '; MAX_HISTORY_BYTES + 1]).unwrap();

        let error = History::load_from("https://notes.example.test", dir.path()).unwrap_err();

        assert!(error.contains("exceeds"));
    }

    #[cfg(unix)]
    #[test]
    fn creates_private_directory_and_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let mut history = History::load_from("https://notes.example.test", dir.path()).unwrap();
        history.push("return true").unwrap();

        let history_dir = dir.path().join("repl-history");
        let path = history_path("https://notes.example.test", dir.path());
        assert_eq!(
            std::fs::metadata(history_dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn corrupt_history_is_reported_without_overwriting_it() {
        let dir = tempfile::tempdir().unwrap();
        let history_dir = dir.path().join("repl-history");
        std::fs::create_dir_all(&history_dir).unwrap();
        let path = history_path("https://notes.example.test", dir.path());
        std::fs::write(&path, b"not json").unwrap();

        let error = History::load_from("https://notes.example.test", dir.path()).unwrap_err();

        assert!(error.contains("parsing REPL history"));
        assert_eq!(std::fs::read(path).unwrap(), b"not json");
    }
}
