use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Context {
    pub row: usize,
    pub start: usize,
    pub end: usize,
    pub path: Vec<String>,
    pub prefix: String,
}

#[derive(Clone, Debug)]
pub(super) struct Candidate {
    pub name: String,
    pub detail: String,
    pub description: String,
}

pub(super) fn context(lines: &[String], row: usize, column: usize) -> Option<Context> {
    let line = lines.get(row)?;
    let before: String = line.chars().take(column).collect();
    let source = format!("{}\n{before}", lines[..row].join("\n"));
    if !in_code(source.as_bytes()) {
        return None;
    }
    let suffix: String = before
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.')
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    if before[..before.len() - suffix.len()].ends_with(':') {
        return None;
    }
    let mut parts: Vec<_> = suffix.split('.').collect();
    let prefix = parts.pop()?;
    if parts.iter().any(|part| !identifier(part)) || (!prefix.is_empty() && !identifier(prefix)) {
        return None;
    }
    let after = line
        .chars()
        .skip(column)
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .count();
    Some(Context {
        row,
        start: column - prefix.len(),
        end: column + after,
        path: parts.into_iter().map(str::to_owned).collect(),
        prefix: prefix.into(),
    })
}

fn identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !matches!(
            text,
            "and"
                | "break"
                | "do"
                | "else"
                | "elseif"
                | "end"
                | "false"
                | "for"
                | "function"
                | "goto"
                | "if"
                | "in"
                | "local"
                | "nil"
                | "not"
                | "or"
                | "repeat"
                | "return"
                | "then"
                | "true"
                | "until"
                | "while"
        )
}

fn long_open(bytes: &[u8]) -> Option<usize> {
    if bytes.first() != Some(&b'[') {
        return None;
    }
    let equals = bytes[1..].iter().take_while(|b| **b == b'=').count();
    (bytes.get(equals + 1) == Some(&b'[')).then_some(equals)
}

fn in_code(bytes: &[u8]) -> bool {
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"--") {
            i += 2;
            if long_open(&bytes[i..]).is_none() {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                if i == bytes.len() {
                    return false;
                }
                continue;
            }
        }
        if let Some(equals) = long_open(&bytes[i..]) {
            i += equals + 2;
            let close = format!("]{}]", "=".repeat(equals));
            let offset = bytes[i..]
                .windows(close.len())
                .position(|window| window == close.as_bytes());
            let Some(offset) = offset else {
                return false;
            };
            i += offset + close.len();
        } else if matches!(bytes[i], b'\'' | b'"') {
            let quote = bytes[i];
            i += 1;
            loop {
                if i >= bytes.len() {
                    return false;
                }
                if bytes[i] == quote {
                    i += 1;
                    break;
                }
                if bytes[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
        } else {
            i += 1;
        }
    }
    true
}

pub(super) fn candidates(value: &Value) -> Vec<Candidate> {
    let Some(properties) = value.get("properties").and_then(Value::as_array) else {
        return vec![];
    };
    let mut result: Vec<_> = properties
        .iter()
        .take(4096)
        .filter_map(|property| {
            let name = property.get("key")?.as_str()?;
            if !identifier(name) {
                return None;
            }
            let info = &property["functionInfo"];
            let detail = if property["type"] == "function" {
                let parameters = info["parameters"]
                    .as_array()
                    .map(|params| {
                        params
                            .iter()
                            .take(32)
                            .map(|p| {
                                format!(
                                    "{}{}",
                                    p["name"].as_str().unwrap_or("?"),
                                    if p["optional"] == true { "?" } else { "" }
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_else(|| "…".into());
                format!("({parameters})")
            } else {
                property["type"].as_str().unwrap_or("value").into()
            };
            Some(Candidate {
                name: name.into(),
                detail: detail.chars().take(512).collect(),
                description: info["description"]
                    .as_str()
                    .unwrap_or("")
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(1024)
                    .collect(),
            })
        })
        .collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    result.dedup_by(|a, b| a.name == b.name);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_member_at_cursor_without_replacing_surrounding_code() {
        let lines = vec!["return index.query(2)".into()];
        assert_eq!(
            context(&lines, 0, 15),
            Some(Context {
                row: 0,
                start: 13,
                end: 18,
                path: vec!["index".into()],
                prefix: "qu".into()
            })
        );
    }
    #[test]
    fn ignores_strings_comments_and_computed_expressions() {
        for source in [
            "'index.q",
            "-- index.q",
            "[=[index.q",
            "--[==[\nindex.q",
            "call().q",
            "row[1].q",
            "object:q",
            "1.2",
        ] {
            let lines: Vec<String> = source.lines().map(str::to_owned).collect();
            let row = lines.len() - 1;
            assert!(
                context(&lines, row, lines[row].chars().count()).is_none(),
                "{source}"
            );
        }
        assert!(context(&["\"closed\"; index.q".into()], 0, 17).is_some());
    }
    #[test]
    fn keeps_safe_names_and_function_metadata() {
        let result = candidates(&serde_json::json!({"properties":[
            {"key":"query","type":"function","functionInfo":{"parameters":[{"name":"source"}],"description":"Run query.\nMore detail."}},
            {"key":"bad.name","type":"table"}, {"key":"end","type":"function"}
        ]}));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "query");
        assert_eq!(result[0].detail, "(source)");
        assert_eq!(result[0].description, "Run query.");
    }
}
