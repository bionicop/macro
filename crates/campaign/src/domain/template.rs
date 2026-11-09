//! Merge fields: `{{Column name}}` or `{{Column name|fallback}}` in subjects
//! and bodies, filled from the recipient's row and contact.

use super::models::CampaignError;
use std::collections::HashMap;

/// Built-in fields every recipient has.
pub const BUILT_IN: [&str; 3] = ["email", "name", "first name"];

/// Field values for one recipient, keyed by normalized name.
#[derive(Debug, Clone, Default)]
pub struct MergeFields(HashMap<String, String>);

impl MergeFields {
    /// Set a field; a later value for the same name wins.
    pub fn insert(&mut self, name: &str, value: impl Into<String>) {
        self.0.insert(normalize(name), value.into());
    }

    /// The built-in fields of a recipient.
    pub fn for_recipient(email: &str, name: Option<&str>) -> Self {
        let mut fields = Self::default();
        let name = name.unwrap_or_default().trim();
        fields.insert("email", email);
        fields.insert("name", name);
        fields.insert("first name", name.split_whitespace().next().unwrap_or_default());
        fields
    }
}

/// Field names compare case-insensitively, with `_` as a space.
pub fn normalize(name: &str) -> String {
    name.replace('_', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// A placeholder in a template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Placeholder<'a> {
    /// Normalized field name.
    pub name: String,
    /// Text used when the field is empty or unknown.
    pub fallback: Option<&'a str>,
}

/// Split a template into literal text and placeholders.
fn parts(template: &str) -> Vec<Result<&str, Placeholder<'_>>> {
    let mut parts = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        let Some(close) = rest[open + 2..].find("}}") else {
            break;
        };
        parts.push(Ok(&rest[..open]));
        let inner = &rest[open + 2..open + 2 + close];
        let (name, fallback) = match inner.split_once('|') {
            Some((name, fallback)) => (name, Some(fallback.trim())),
            None => (inner, None),
        };
        parts.push(Err(Placeholder {
            name: normalize(name),
            fallback,
        }));
        rest = &rest[open + 2 + close + 2..];
    }
    parts.push(Ok(rest));
    parts
}

/// Names a template uses without a fallback, for validation before launch.
pub fn required_fields(template: &str) -> Vec<String> {
    parts(template)
        .into_iter()
        .filter_map(|part| match part {
            Err(Placeholder {
                name,
                fallback: None,
            }) => Some(name),
            _ => None,
        })
        .collect()
}

/// Fail on the first field without a fallback that is neither built in nor
/// one of `columns`.
pub fn check_fields<'a>(
    templates: impl IntoIterator<Item = &'a str>,
    columns: &[String],
) -> Result<(), CampaignError> {
    let known: Vec<String> = columns.iter().map(|name| normalize(name)).collect();
    for template in templates {
        for name in required_fields(template) {
            if !BUILT_IN.contains(&name.as_str()) && !known.contains(&name) {
                return Err(CampaignError::UnknownField(name));
            }
        }
    }
    Ok(())
}

/// Fill a template. Values are escaped for HTML bodies; an empty value uses
/// the fallback.
pub fn render(template: &str, fields: &MergeFields, html: bool) -> Result<String, CampaignError> {
    let mut out = String::with_capacity(template.len());
    for part in parts(template) {
        match part {
            Ok(text) => out.push_str(text),
            Err(placeholder) => {
                let value = fields
                    .0
                    .get(&placeholder.name)
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty());
                let value = match (value, placeholder.fallback) {
                    (Some(value), _) => value,
                    (None, Some(fallback)) => fallback,
                    (None, None) if fields.0.contains_key(&placeholder.name) => "",
                    (None, None) => return Err(CampaignError::UnknownField(placeholder.name)),
                };
                if html {
                    escape_html(value, &mut out);
                } else {
                    out.push_str(value);
                }
            }
        }
    }
    Ok(out)
}

fn escape_html(value: &str, out: &mut String) {
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn fields() -> MergeFields {
        let mut fields = MergeFields::for_recipient("ada@example.com", Some("Ada Lovelace"));
        fields.insert("Company", "Analytical <Engines>");
        fields.insert("Title", "");
        fields
    }

    #[test]
    fn fills_built_in_and_column_fields() {
        assert_eq!(
            render("Hi {{ First_Name }}, from {{company}}", &fields(), false).unwrap(),
            "Hi Ada, from Analytical <Engines>"
        );
    }

    #[test]
    fn escapes_values_in_html() {
        assert_eq!(
            render("<p>{{Company}}</p>", &fields(), true).unwrap(),
            "<p>Analytical &lt;Engines&gt;</p>"
        );
    }

    #[test]
    fn empty_values_use_the_fallback() {
        assert_eq!(
            render("{{Title|there}} / {{Title}}.", &fields(), false).unwrap(),
            "there / ."
        );
    }

    #[test]
    fn unknown_fields_without_a_fallback_fail() {
        assert!(matches!(
            render("{{Budget}}", &fields(), false),
            Err(CampaignError::UnknownField(name)) if name == "budget"
        ));
        assert_eq!(render("{{Budget|n/a}}", &fields(), false).unwrap(), "n/a");
    }

    #[test]
    fn unclosed_braces_are_text() {
        assert_eq!(render("a {{b", &fields(), false).unwrap(), "a {{b");
    }

    #[test]
    fn checks_fields_against_columns() {
        let columns = vec!["Company".to_string()];
        assert!(check_fields(["{{company}} {{first name}} {{x|y}}"], &columns).is_ok());
        assert!(check_fields(["{{Role}}"], &columns).is_err());
    }
}
