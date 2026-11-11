//! Bounded block context for an explicitly requested fragment preview. Unknown
//! or truncated container syntax is reported rather than guessed silently.
use super::{
    large_text_view::{ImmutableBase, ViewError},
    persistent_text::SegmentedTextView,
};
enum Block {
    Fence {
        marker: u8,
        count: usize,
        opening: String,
    },
    Math(String),
    Html {
        opening: String,
        end: Option<String>,
    },
    FrontMatter,
}
pub struct PreviewContext {
    pub prefix: String,
    pub reliable: bool,
}
pub fn context<B: ImmutableBase + ?Sized>(
    view: &SegmentedTextView<B>,
    line: usize,
    column: usize,
) -> Result<PreviewContext, ViewError> {
    let mut scanner = Scanner {
        block: None,
        reliable: true,
    };
    view.visit_line_prefixes_before(line, 4096, |index, text| scanner.line(index, text))?;
    let in_block = scanner.block.is_some();
    let prefix = match scanner.block {
        Some(Block::Fence { opening, .. })
        | Some(Block::Math(opening))
        | Some(Block::Html { opening, .. }) => format!("{opening}\n"),
        Some(Block::FrontMatter) => "---\n".into(),
        None => String::new(),
    };
    Ok(PreviewContext {
        prefix,
        reliable: scanner.reliable && (column == 0 || in_block),
    })
}
struct Scanner {
    block: Option<Block>,
    reliable: bool,
}
impl Scanner {
    fn line(&mut self, index: usize, text: &str) {
        if text.len() >= 4096 {
            self.reliable = false;
        }
        let line = text.trim_end();
        let stripped = line.trim_start();
        let mut closing = stripped;
        while let Some(rest) = closing.strip_prefix('>') {
            closing = rest.trim_start();
        }
        if let Some(block) = &self.block {
            let ended = match block {
                Block::Fence { marker, count, .. } => {
                    let n = closing.bytes().take_while(|b| b == marker).count();
                    n >= *count && closing[n..].trim().is_empty()
                }
                Block::Math(_) => closing == "$$",
                Block::Html { end: Some(end), .. } => stripped.to_ascii_lowercase().contains(end),
                Block::Html { end: None, .. } => stripped.is_empty(),
                Block::FrontMatter => stripped == "---" || stripped == "...",
            };
            if ended {
                self.block = None;
            }
            return;
        }
        if line.starts_with("    ") {
            self.reliable = false;
        }
        if index == 0 && stripped == "---" {
            self.block = Some(Block::FrontMatter);
            return;
        }
        let mut candidate = stripped;
        while let Some(rest) = candidate.strip_prefix('>') {
            candidate = rest.trim_start();
        }
        if let Some(rest) = candidate
            .strip_prefix("- ")
            .or_else(|| candidate.strip_prefix("* "))
            .or_else(|| candidate.strip_prefix("+ "))
        {
            candidate = rest.trim_start();
        } else if let Some(dot) = candidate.find(". ") {
            if candidate[..dot].bytes().all(|b| b.is_ascii_digit()) && !candidate[..dot].is_empty()
            {
                candidate = candidate[dot + 2..].trim_start();
            }
        }
        if candidate.starts_with("```") || candidate.starts_with("~~~") {
            let marker = candidate.as_bytes()[0];
            let count = candidate.bytes().take_while(|b| *b == marker).count();
            if marker == b'`' && candidate[count..].contains('`') {
                return;
            }
            self.block = Some(Block::Fence {
                marker,
                count,
                opening: candidate.into(),
            });
            return;
        }
        if let Some(rest) = candidate.strip_prefix("$$") {
            if !rest.contains("$$") {
                self.block = Some(Block::Math("$$".into()));
            }
            return;
        }
        let lower = candidate.to_ascii_lowercase();
        for (start, end) in [("<!--", "-->"), ("<?", "?>"), ("<![cdata[", "]]>")] {
            if lower.starts_with(start) {
                if !lower[start.len()..].contains(end) {
                    self.block = Some(Block::Html {
                        opening: candidate.into(),
                        end: Some(end.into()),
                    });
                }
                return;
            }
        }
        for tag in ["script", "style", "pre", "textarea"] {
            let open = format!("<{tag}");
            let close = format!("</{tag}>");
            if lower.starts_with(&open) && lower[open.len()..].starts_with(['>', ' ', '\t']) {
                if !lower.contains(&close) {
                    self.block = Some(Block::Html {
                        opening: candidate.into(),
                        end: Some(close),
                    });
                }
                return;
            }
        }
        if lower.starts_with('<') {
            let tag = lower
                .trim_start_matches('<')
                .trim_start_matches('/')
                .split(|ch: char| !ch.is_ascii_alphanumeric())
                .next()
                .unwrap_or("");
            if [
                "address",
                "article",
                "aside",
                "base",
                "blockquote",
                "body",
                "caption",
                "center",
                "col",
                "colgroup",
                "dd",
                "details",
                "dialog",
                "dir",
                "div",
                "dl",
                "dt",
                "fieldset",
                "figcaption",
                "figure",
                "footer",
                "form",
                "frame",
                "frameset",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "head",
                "header",
                "hr",
                "html",
                "iframe",
                "legend",
                "li",
                "link",
                "main",
                "menu",
                "menuitem",
                "nav",
                "noframes",
                "ol",
                "optgroup",
                "option",
                "p",
                "param",
                "search",
                "section",
                "summary",
                "table",
                "tbody",
                "td",
                "tfoot",
                "th",
                "thead",
                "title",
                "tr",
                "track",
                "ul",
            ]
            .contains(&tag)
            {
                self.block = Some(Block::Html {
                    opening: candidate.into(),
                    end: None,
                });
            } else if lower.ends_with('>') {
                self.reliable = false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::large_text_view::MemoryBase;
    use super::*;
    use std::sync::Arc;
    fn at(text: &str, line: usize, column: usize) -> PreviewContext {
        context(
            &SegmentedTextView::new(Arc::new(MemoryBase::from_bytes(text.as_bytes().to_vec()))),
            line,
            column,
        )
        .unwrap()
    }
    #[test]
    fn carries_fences_math_html_and_reports_unknown_partial_inline() {
        assert_eq!(
            at("# title\n```rust\nlet a=1;\n```\nend", 2, 0).prefix,
            "```rust\n"
        );
        assert_eq!(at("```\nx\n```\nend", 3, 0).prefix, "");
        assert_eq!(at("$$\na+b\n$$\nend", 1, 0).prefix, "$$\n");
        assert_eq!(at("$$x$$\nend", 1, 0).prefix, "");
        assert_eq!(
            at("<!-- comment\ninside\n-->\nend", 1, 0).prefix,
            "<!-- comment\n"
        );
        assert_eq!(at("<div>\ninside\n\nend", 1, 0).prefix, "<div>\n");
        assert_eq!(at("<div>\ninside\n\nend", 3, 0).prefix, "");
        assert_eq!(at("> ```js\n> x\n> ```", 1, 0).prefix, "```js\n");
        assert_eq!(at("> ```js\n> x\n> ```\nafter", 3, 0).prefix, "");
        assert!(at("```\nlong code", 1, 4).reliable);
        assert!(!at("plain text", 0, 3).reliable);
        assert!(!at(&format!("{}\npart", "x".repeat(5000)), 1, 0).reliable);
    }
}
