use std::collections::HashSet;
use std::io::{self, Write};

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use serde_json::{Map, Value};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const MAX_PREVIEW_ROWS: usize = 20;
const MAX_TABLE_COLUMNS: usize = 24;
const MAX_DISCOVERED_COLUMNS: usize = 256;
const MAX_COLUMN_SCAN_ROWS: usize = 10_000;
const MAX_PREVIEW_CELL_WIDTH: usize = 48;
const MAX_PREVIEW_SCALAR_WIDTH: usize = 240;
const MAX_EXPANDED_CELL_WIDTH: usize = 512;
const MAX_EXPANDED_LINES: usize = 400;
const MAX_TREE_DEPTH: usize = 8;
const MAX_JSON_LINE_WIDTH: usize = 2048;
const MAX_JSON_BYTES: usize = MAX_EXPANDED_LINES * MAX_JSON_LINE_WIDTH;

#[derive(Clone)]
struct Cell {
    text: String,
    style: Style,
}

impl Cell {
    fn new(text: impl Into<String>, style: Style) -> Self {
        Self {
            text: text.into(),
            style,
        }
    }
}

pub fn render(value: &Value, raw: bool, expanded: bool) -> Vec<Line<'static>> {
    if raw {
        return render_json(value);
    }
    if let Value::String(text) = value {
        return render_string(text, expanded);
    }
    if expanded && matches!(value, Value::Array(_) | Value::Object(_)) {
        return render_tree(value);
    }
    render_preview(value)
}

fn render_string(text: &str, expanded: bool) -> Vec<Line<'static>> {
    let line_limit = if expanded {
        MAX_EXPANDED_LINES
    } else {
        MAX_PREVIEW_ROWS
    };
    let width_limit = if expanded {
        MAX_EXPANDED_CELL_WIDTH
    } else {
        MAX_PREVIEW_SCALAR_WIDTH
    };
    let mut source = text.split('\n');
    let mut lines = source
        .by_ref()
        .take(line_limit)
        .map(|line| {
            Line::from(Span::styled(
                truncate_display(&safe_text(line), width_limit),
                Style::default().fg(Color::Green),
            ))
        })
        .collect::<Vec<_>>();
    let remaining = source.count();
    if remaining > 0 {
        lines.push(notice_line(format!(
            "… {remaining} more {}",
            if remaining == 1 { "line" } else { "lines" }
        )));
    }
    lines
}

pub fn safe_text(text: &str) -> String {
    let mut safe = String::with_capacity(text.len());
    for character in text.chars() {
        if character.is_control() {
            safe.extend(character.escape_default());
        } else {
            safe.push(character);
        }
    }
    safe
}

fn render_preview(value: &Value) -> Vec<Line<'static>> {
    match value {
        Value::Array(items) if items.is_empty() => vec![empty_line("[] (empty array)")],
        Value::Object(object) if object.is_empty() => vec![empty_line("{} (empty object)")],
        Value::Array(items) if items.iter().all(Value::is_object) => render_object_array(items),
        Value::Array(items) => render_list(items),
        Value::Object(object) => render_object(object),
        value => vec![Line::from(Span::styled(
            truncate_display(&scalar_text(value), MAX_PREVIEW_SCALAR_WIDTH),
            scalar_style(value),
        ))],
    }
}

fn render_object_array(items: &[Value]) -> Vec<Line<'static>> {
    let mut columns = Vec::new();
    let mut seen = HashSet::new();
    let mut omitted_columns = 0;
    let mut discovery_limited = false;

    for object in items
        .iter()
        .take(MAX_COLUMN_SCAN_ROWS)
        .filter_map(Value::as_object)
    {
        for key in object.keys() {
            if seen.contains(key) {
                continue;
            }
            if seen.len() >= MAX_DISCOVERED_COLUMNS {
                discovery_limited = true;
                continue;
            }
            seen.insert(key.clone());
            if columns.len() < MAX_TABLE_COLUMNS {
                columns.push(key.clone());
            } else {
                omitted_columns += 1;
            }
        }
    }

    if columns.is_empty() {
        return render_list(items);
    }

    let headers = columns
        .iter()
        .map(|key| {
            Cell::new(
                truncate_display(&safe_text(key), MAX_PREVIEW_CELL_WIDTH),
                header_style(),
            )
        })
        .collect::<Vec<_>>();
    let rows = items
        .iter()
        .take(MAX_PREVIEW_ROWS)
        .filter_map(Value::as_object)
        .map(|object| {
            columns
                .iter()
                .map(|column| match object.get(column) {
                    Some(value) => preview_cell(value),
                    None => missing_cell(),
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut lines = boxed_table(headers, rows);

    if omitted_columns > 0 || discovery_limited {
        let suffix = if discovery_limited {
            format!(
                "at least {} more columns",
                MAX_DISCOVERED_COLUMNS - MAX_TABLE_COLUMNS
            )
        } else {
            format!("{omitted_columns} more columns")
        };
        lines.push(notice_line(format!("… {suffix}")));
    }
    if items.len() > MAX_COLUMN_SCAN_ROWS {
        lines.push(notice_line(format!(
            "… columns inspected in the first {MAX_COLUMN_SCAN_ROWS} rows"
        )));
    }
    if items.len() > MAX_PREVIEW_ROWS {
        lines.push(notice_line(format!(
            "… {} more rows",
            items.len() - MAX_PREVIEW_ROWS
        )));
    }
    lines
}

fn render_object(object: &Map<String, Value>) -> Vec<Line<'static>> {
    let headers = vec![
        Cell::new("property", header_style()),
        Cell::new("value", header_style()),
    ];
    let rows = object
        .iter()
        .take(MAX_PREVIEW_ROWS)
        .map(|(key, value)| {
            vec![
                Cell::new(
                    truncate_display(&safe_text(key), MAX_PREVIEW_CELL_WIDTH),
                    Style::default().fg(Color::Blue),
                ),
                preview_cell(value),
            ]
        })
        .collect::<Vec<_>>();
    let mut lines = boxed_table(headers, rows);
    if object.len() > MAX_PREVIEW_ROWS {
        lines.push(notice_line(format!(
            "… {} more properties",
            object.len() - MAX_PREVIEW_ROWS
        )));
    }
    lines
}

fn render_list(items: &[Value]) -> Vec<Line<'static>> {
    let mut lines = items
        .iter()
        .take(MAX_PREVIEW_ROWS)
        .enumerate()
        .map(|(index, value)| {
            Line::from(vec![
                Span::styled(format!("[{index}] "), Style::default().fg(Color::DarkGray)),
                Span::styled(
                    truncate_display(&summary_text(value), MAX_PREVIEW_SCALAR_WIDTH),
                    scalar_style(value),
                ),
            ])
        })
        .collect::<Vec<_>>();
    if items.len() > MAX_PREVIEW_ROWS {
        lines.push(notice_line(format!(
            "… {} more items",
            items.len() - MAX_PREVIEW_ROWS
        )));
    }
    lines
}

fn boxed_table(headers: Vec<Cell>, rows: Vec<Vec<Cell>>) -> Vec<Line<'static>> {
    let mut widths = headers
        .iter()
        .map(|cell| UnicodeWidthStr::width(cell.text.as_str()))
        .collect::<Vec<_>>();
    for row in &rows {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(UnicodeWidthStr::width(cell.text.as_str()));
        }
    }

    let mut lines = vec![
        border_line('┌', '┬', '┐', &widths),
        table_line(&headers, &widths),
    ];
    lines.push(border_line('├', '┼', '┤', &widths));
    lines.extend(rows.iter().map(|row| table_line(row, &widths)));
    lines.push(border_line('└', '┴', '┘', &widths));
    lines
}

fn border_line(left: char, middle: char, right: char, widths: &[usize]) -> Line<'static> {
    let mut text = String::new();
    text.push(left);
    for (index, width) in widths.iter().enumerate() {
        text.push_str(&"─".repeat(width + 2));
        text.push(if index + 1 == widths.len() {
            right
        } else {
            middle
        });
    }
    Line::from(Span::styled(text, border_style()))
}

fn table_line(cells: &[Cell], widths: &[usize]) -> Line<'static> {
    let mut spans = vec![Span::styled("│ ", border_style())];
    for (index, cell) in cells.iter().enumerate() {
        spans.push(Span::styled(cell.text.clone(), cell.style));
        spans.push(Span::raw(" ".repeat(
            widths[index].saturating_sub(UnicodeWidthStr::width(cell.text.as_str())),
        )));
        spans.push(Span::styled(
            if index + 1 == cells.len() {
                " │"
            } else {
                " │ "
            },
            border_style(),
        ));
    }
    Line::from(spans)
}

fn preview_cell(value: &Value) -> Cell {
    Cell::new(
        truncate_display(&summary_text(value), MAX_PREVIEW_CELL_WIDTH),
        scalar_style(value),
    )
}

fn missing_cell() -> Cell {
    Cell::new("—", Style::default().fg(Color::DarkGray))
}

fn summary_text(value: &Value) -> String {
    match value {
        Value::Array(items) if items.is_empty() => "[] (empty array)".to_string(),
        Value::Array(items) => format!(
            "[{} {}]",
            items.len(),
            if items.len() == 1 { "item" } else { "items" }
        ),
        Value::Object(object) if object.is_empty() => "{} (empty object)".to_string(),
        Value::Object(object) => format!(
            "{{{} {}}}",
            object.len(),
            if object.len() == 1 {
                "property"
            } else {
                "properties"
            }
        ),
        value => scalar_text(value),
    }
}

fn scalar_text(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => safe_text(value),
        Value::Array(_) | Value::Object(_) => summary_text(value),
    }
}

fn scalar_style(value: &Value) -> Style {
    match value {
        Value::Null => Style::default().fg(Color::Magenta),
        Value::Bool(_) => Style::default().fg(Color::Yellow),
        Value::Number(_) => Style::default().fg(Color::Cyan),
        Value::String(_) => Style::default().fg(Color::Green),
        Value::Array(_) | Value::Object(_) => Style::default().fg(Color::LightBlue),
    }
}

fn header_style() -> Style {
    Style::default()
        .fg(Color::LightCyan)
        .add_modifier(Modifier::BOLD)
}

fn border_style() -> Style {
    Style::default().fg(Color::DarkGray)
}

fn empty_line(text: &'static str) -> Line<'static> {
    Line::from(Span::styled(text, Style::default().fg(Color::DarkGray)))
}

fn notice_line(text: String) -> Line<'static> {
    Line::from(Span::styled(
        text,
        Style::default()
            .fg(Color::DarkGray)
            .add_modifier(Modifier::ITALIC),
    ))
}

fn render_tree(value: &Value) -> Vec<Line<'static>> {
    let mut renderer = TreeRenderer::default();
    renderer.value(value, 0, Vec::new());
    if renderer.truncated {
        renderer.lines.push(notice_line(format!(
            "… output truncated after {MAX_EXPANDED_LINES} lines"
        )));
    }
    renderer.lines
}

#[derive(Default)]
struct TreeRenderer {
    lines: Vec<Line<'static>>,
    truncated: bool,
}

impl TreeRenderer {
    fn value(&mut self, value: &Value, depth: usize, mut prefix: Vec<Span<'static>>) {
        if self.truncated {
            return;
        }
        prefix.insert(0, Span::raw("  ".repeat(depth)));
        if depth >= MAX_TREE_DEPTH && matches!(value, Value::Array(_) | Value::Object(_)) {
            prefix.push(Span::styled(
                format!("{} … (depth limit {MAX_TREE_DEPTH})", summary_text(value)),
                Style::default().fg(Color::DarkGray),
            ));
            self.push(Line::from(prefix));
            return;
        }

        match value {
            Value::Array(items) if items.is_empty() => {
                prefix.push(Span::styled(
                    "[] (empty array)",
                    Style::default().fg(Color::DarkGray),
                ));
                self.push(Line::from(prefix));
            }
            Value::Object(object) if object.is_empty() => {
                prefix.push(Span::styled(
                    "{} (empty object)",
                    Style::default().fg(Color::DarkGray),
                ));
                self.push(Line::from(prefix));
            }
            Value::Array(items) => {
                prefix.push(Span::styled("[", border_style()));
                self.push(Line::from(prefix));
                for (index, item) in items.iter().enumerate() {
                    self.value(
                        item,
                        depth + 1,
                        vec![Span::styled(
                            format!("[{index}] "),
                            Style::default().fg(Color::DarkGray),
                        )],
                    );
                    if self.truncated {
                        break;
                    }
                }
                self.push(Line::from(vec![
                    Span::raw("  ".repeat(depth)),
                    Span::styled("]", border_style()),
                ]));
            }
            Value::Object(object) => {
                prefix.push(Span::styled("{", border_style()));
                self.push(Line::from(prefix));
                for (key, item) in object {
                    self.value(
                        item,
                        depth + 1,
                        vec![
                            Span::styled(
                                truncate_display(&safe_text(key), MAX_PREVIEW_CELL_WIDTH),
                                Style::default().fg(Color::Blue),
                            ),
                            Span::styled(": ", border_style()),
                        ],
                    );
                    if self.truncated {
                        break;
                    }
                }
                self.push(Line::from(vec![
                    Span::raw("  ".repeat(depth)),
                    Span::styled("}", border_style()),
                ]));
            }
            value => {
                prefix.push(Span::styled(
                    truncate_display(&scalar_text(value), MAX_EXPANDED_CELL_WIDTH),
                    scalar_style(value),
                ));
                self.push(Line::from(prefix));
            }
        }
    }

    fn push(&mut self, line: Line<'static>) {
        if self.lines.len() < MAX_EXPANDED_LINES {
            self.lines.push(line);
        } else {
            self.truncated = true;
        }
    }
}

fn render_json(value: &Value) -> Vec<Line<'static>> {
    let mut output = LimitedWriter::new(MAX_JSON_BYTES);
    let serialized = serde_json::to_writer_pretty(&mut output, value);
    let json = String::from_utf8_lossy(&output.bytes);
    let mut lines = Vec::new();
    let mut truncated = output.truncated || serialized.is_err();
    let mut source = json.lines();
    for line in source.by_ref().take(MAX_EXPANDED_LINES) {
        let safe = safe_text(line);
        let bounded = truncate_display(&safe, MAX_JSON_LINE_WIDTH);
        truncated |= bounded != safe;
        lines.push(Line::from(Span::styled(
            bounded,
            Style::default().fg(Color::LightCyan),
        )));
    }
    truncated |= source.next().is_some();
    if truncated {
        lines.push(notice_line(
            "… JSON display truncated; copy or export for the full value".to_string(),
        ));
    }
    lines
}

struct LimitedWriter {
    bytes: Vec<u8>,
    max_bytes: usize,
    truncated: bool,
}

impl LimitedWriter {
    fn new(max_bytes: usize) -> Self {
        Self {
            bytes: Vec::new(),
            max_bytes,
            truncated: false,
        }
    }
}

impl Write for LimitedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let remaining = self.max_bytes.saturating_sub(self.bytes.len());
        if remaining == 0 {
            self.truncated = true;
            return Err(io::Error::other("JSON display limit reached"));
        }
        if bytes.len() <= remaining {
            self.bytes.extend_from_slice(bytes);
            return Ok(bytes.len());
        }

        let mut boundary = remaining;
        while boundary > 0 && std::str::from_utf8(&bytes[..boundary]).is_err() {
            boundary -= 1;
        }
        self.bytes.extend_from_slice(&bytes[..boundary]);
        self.truncated = true;
        Err(io::Error::other("JSON display limit reached"))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn truncate_display(text: &str, max_width: usize) -> String {
    if UnicodeWidthStr::width(text) <= max_width {
        return text.to_string();
    }
    if max_width == 0 {
        return String::new();
    }

    let content_width = max_width - 1;
    let mut width = 0;
    let mut truncated = String::new();
    for character in text.chars() {
        let character_width = UnicodeWidthChar::width(character).unwrap_or(0);
        if width + character_width > content_width {
            break;
        }
        truncated.push(character);
        width += character_width;
    }
    truncated.push('…');
    truncated
}

#[cfg(test)]
mod tests {
    use ratatui::style::Color;
    use ratatui::text::Line;
    use serde_json::json;

    use super::*;

    fn text(lines: &[Line<'_>]) -> Vec<String> {
        lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect()
            })
            .collect()
    }

    #[test]
    fn table_uses_union_columns_and_distinguishes_missing_from_null() {
        let lines = render(
            &json!([
                {"name": "Tokyo", "score": null},
                {"name": "Oslo", "extra": true}
            ]),
            false,
            false,
        );

        assert_eq!(
            text(&lines),
            [
                "┌───────┬───────┬───────┐",
                "│ name  │ score │ extra │",
                "├───────┼───────┼───────┤",
                "│ Tokyo │ null  │ —     │",
                "│ Oslo  │ —     │ true  │",
                "└───────┴───────┴───────┘",
            ]
        );

        let null_span = lines[3]
            .spans
            .iter()
            .find(|span| span.content == "null")
            .unwrap();
        let missing_span = lines[3]
            .spans
            .iter()
            .find(|span| span.content == "—")
            .unwrap();
        assert_ne!(null_span.style.fg, missing_span.style.fg);
    }

    #[test]
    fn object_renders_property_value_table_with_nested_summaries() {
        let lines = render(
            &json!({"name": "Ada", "active": true, "meta": {"role": "writer"}}),
            false,
            false,
        );

        assert_eq!(
            text(&lines),
            [
                "┌──────────┬──────────────┐",
                "│ property │ value        │",
                "├──────────┼──────────────┤",
                "│ name     │ Ada          │",
                "│ active   │ true         │",
                "│ meta     │ {1 property} │",
                "└──────────┴──────────────┘",
            ]
        );
    }

    #[test]
    fn scalar_arrays_are_indexed_and_empty_containers_are_explicit() {
        assert_eq!(
            text(&render(&json!(["first", 2, null, []]), false, false)),
            ["[0] first", "[1] 2", "[2] null", "[3] [] (empty array)"]
        );
        assert_eq!(
            text(&render(&json!([]), false, false)),
            ["[] (empty array)"]
        );
        assert_eq!(
            text(&render(&json!({}), false, false)),
            ["{} (empty object)"]
        );
    }

    #[test]
    fn expanded_mode_renders_a_tree() {
        let lines = render(
            &json!({"profile": {"name": "Ada"}, "tags": ["one", "two"]}),
            false,
            true,
        );

        assert_eq!(
            text(&lines),
            [
                "{",
                "  profile: {",
                "    name: Ada",
                "  }",
                "  tags: [",
                "    [0] one",
                "    [1] two",
                "  ]",
                "}",
            ]
        );
    }

    #[test]
    fn json_mode_is_pretty_and_bounded() {
        let lines = render(&json!({"key": [1, 2]}), true, false);
        assert_eq!(
            text(&lines),
            ["{", "  \"key\": [", "    1,", "    2", "  ]", "}"]
        );

        let huge = json!((0..600).collect::<Vec<_>>());
        let rendered = text(&render(&huge, true, true));
        assert!(rendered.len() <= 402);
        assert!(rendered.last().unwrap().contains("truncated"));
    }

    #[test]
    fn compact_preview_limits_rows_and_unicode_display_width() {
        let items = (0..40)
            .map(|index| json!({"名前": format!("東京{index}"), "value": index}))
            .collect();
        let rendered = text(&render(&serde_json::Value::Array(items), false, false));

        assert!(rendered.len() <= 27);
        assert!(rendered.last().unwrap().contains("more rows"));
        assert!(rendered.iter().any(|line| line.contains("東京0")));
    }

    #[test]
    fn table_bounds_pathological_column_names() {
        let mut object = serde_json::Map::new();
        object.insert("x".repeat(10_000), json!(1));

        let rendered = text(&render(
            &serde_json::Value::Array(vec![serde_json::Value::Object(object)]),
            false,
            false,
        ));

        assert!(
            rendered
                .iter()
                .all(|line| UnicodeWidthStr::width(line.as_str()) <= 64),
            "{rendered:#?}"
        );
    }

    #[test]
    fn expanded_mode_stops_at_a_safe_depth() {
        let mut value = json!("leaf");
        for _ in 0..20 {
            value = json!({"next": value});
        }

        let rendered = text(&render(&value, false, true));
        assert!(rendered.iter().any(|line| line.contains("depth limit")));
        assert!(rendered.len() < 30);
    }

    #[test]
    fn terminal_controls_are_escaped_before_rendering() {
        assert_eq!(
            safe_text("ok\n\u{1b}[31m\t\u{7}"),
            "ok\\n\\u{1b}[31m\\t\\u{7}"
        );

        let rendered = render(&json!("ok\n\u{1b}[31m"), false, false);
        assert_eq!(text(&rendered), ["ok", "\\u{1b}[31m"]);
        assert!(rendered.iter().all(|line| line.spans.iter().all(|span| {
            span.content
                .chars()
                .all(|character| !character.is_control())
        })));
    }

    #[test]
    fn scalar_strings_preserve_line_breaks_and_bound_the_preview() {
        assert_eq!(
            text(&render(&json!("first\nsecond\n"), false, false)),
            ["first", "second", ""]
        );

        let long = (0..30)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let rendered = text(&render(&json!(long), false, false));
        assert_eq!(rendered.len(), 21);
        assert_eq!(rendered.last().unwrap(), "… 10 more lines");
    }

    #[test]
    fn scalar_types_have_distinct_semantic_colors() {
        let string = render(&json!("text"), false, false);
        let number = render(&json!(42), false, false);
        let null = render(&serde_json::Value::Null, false, false);

        assert_eq!(string[0].spans[0].style.fg, Some(Color::Green));
        assert_eq!(number[0].spans[0].style.fg, Some(Color::Cyan));
        assert_eq!(null[0].spans[0].style.fg, Some(Color::Magenta));
    }
}
