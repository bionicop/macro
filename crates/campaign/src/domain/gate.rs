//! The last check before an email leaves: deterministic, no network, no model.
//!
//! Adapted from Sellbird's pre-send gate (AGPL-3.0, github.com/ethanplusai/sellbird,
//! `sellbird/gate.py`). Sellbird guards mail an AI drafted, so it also bans phrases
//! and caps length and links. A campaign here is written by a person, so only
//! mistakes that can never be right block the send ([`check`]); style problems are
//! advice that is logged and never stops anything ([`lint`]).

/// Why an email must not go out. Every reason is a mistake no sender wants.
pub fn check(to_email: &str, subject: &str, body_text: &str) -> Result<(), Vec<String>> {
    let mut reasons = Vec::new();
    if !valid_address(to_email) {
        reasons.push(format!("invalid recipient address '{}'", to_email.trim()));
    }
    if subject.trim().is_empty() {
        reasons.push("empty subject".to_string());
    }
    if body_text.trim().is_empty() {
        reasons.push("empty body".to_string());
    }
    // A line break in a header value would let a merge field add headers.
    if subject.contains(['\r', '\n']) {
        reasons.push("line break in subject".to_string());
    }
    let mut leftover = merge_tags(subject);
    leftover.extend(merge_tags(body_text));
    leftover.sort();
    leftover.dedup();
    if !leftover.is_empty() {
        leftover.truncate(3);
        reasons.push(format!("unrendered merge tags: {}", leftover.join(", ")));
    }
    if reasons.is_empty() { Ok(()) } else { Err(reasons) }
}

/// Style advice a human sender may ignore: spam-filter and AI-tell phrases, a long
/// subject or body, many links.
pub fn lint(subject: &str, body_text: &str) -> Vec<String> {
    let mut advice = Vec::new();
    let subject = subject.trim();
    if subject.chars().count() > MAX_SUBJECT_CHARS {
        advice.push(format!("subject is longer than {MAX_SUBJECT_CHARS} characters"));
    }
    let words = body_text.split_whitespace().count();
    if words > MAX_BODY_WORDS {
        advice.push(format!("body has {words} words, more than {MAX_BODY_WORDS}"));
    }
    let lowered = format!("{subject} {body_text}").to_lowercase();
    let hits: Vec<&str> = BANNED_PHRASES
        .iter()
        .copied()
        .filter(|phrase| lowered.contains(phrase))
        .take(3)
        .collect();
    if !hits.is_empty() {
        advice.push(format!("phrases that trip spam filters: {}", hits.join(", ")));
    }
    let links = body_text
        .split_whitespace()
        .filter(|word| {
            let word = word.trim_start_matches(['(', '<', '[', '"', '\'']).to_ascii_lowercase();
            word.starts_with("http://") || word.starts_with("https://")
        })
        .count();
    if links > MAX_LINKS {
        advice.push(format!("{links} links, more than {MAX_LINKS}"));
    }
    advice
}

const MAX_SUBJECT_CHARS: usize = 90;
const MAX_BODY_WORDS: usize = 220;
const MAX_LINKS: usize = 3;

/// Spam-filter and AI-tell phrases, from Sellbird's gate.
const BANNED_PHRASES: &[&str] = &[
    "act now",
    "buy now",
    "click here",
    "click below",
    "limited time",
    "limited offer",
    "exclusive deal",
    "special offer",
    "risk-free",
    "no obligation",
    "100% free",
    "make money",
    "double your",
    "guaranteed results",
    "congratulations",
    "i hope this finds you well",
    "hope this email finds you well",
    "i hope this email finds you",
    "picture this",
    "what if i told you",
    "in today's fast-paced world",
    "game-changer",
    "game changer",
    "cutting-edge solution",
    "revolutionize your",
    "unlock your",
    "supercharge your",
    "as an ai",
    "i'm an ai",
    "i am an ai",
    "as a language model",
];

/// A name, one `@`, then a dotted host: no spaces or control characters, a dotted host
/// whose labels are non-empty and whose last label is at least two letters.
pub fn valid_address(address: &str) -> bool {
    let address = address.trim();
    if address.len() > 254 || address.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some((local, host)) = address.split_once('@') else {
        return false;
    };
    if local.is_empty()
        || local.len() > 64
        || !local
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._%+-'".contains(c))
    {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_alphanumeric() || c == '-')
        })
        && labels
            .last()
            .is_some_and(|tld| tld.chars().count() >= 2 && tld.chars().all(char::is_alphabetic))
}

/// `{{name}}` and `{name}` left in rendered text: a merge field that did not
/// render, or one written with the wrong braces.
fn merge_tags(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'{' {
            i += 1;
            continue;
        }
        let double = bytes.get(i + 1) == Some(&b'{');
        let start = i + if double { 2 } else { 1 };
        let Some(len) = text[start..].find('}') else {
            i += 1;
            continue;
        };
        let inner = &text[start..start + len];
        let closes = if double {
            text[start + len..].starts_with("}}")
        } else {
            // A single-brace tag is `{name}` not followed by another `}`.
            text[start + len + 1..].chars().next() != Some('}')
        };
        let name = inner.trim();
        if closes
            && !name.is_empty()
            && name.chars().all(|c| c.is_alphanumeric() || c == '_')
        {
            found.push(if double { format!("{{{{{name}}}}}") } else { format!("{{{name}}}") });
            i = start + len + if double { 2 } else { 1 };
        } else {
            i += 1;
        }
    }
    found
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn clean_mail_passes() {
        assert!(check("ada@example.com", "Hello", "Hi Ada, a quick note.").is_ok());
    }

    #[test]
    fn bad_addresses_are_refused() {
        for (local, host) in [("", "example.com"), ("ada", ""), ("ada", "example"), ("a da", "example.com"), ("ada", "exa mple.com"), ("ada", "-x.com"), ("ada", "example.c"), ("ada", "example..com"), ("ada@", "example.com")] {
            let bad = format!("{local}@{host}");
            assert!(!valid_address(&bad), "{bad:?} should be invalid");
        }
        for (local, host) in [("ada", "example.com"), ("ada.l+news", "mail.example.co.uk"), ("o'brien", "example.ie"), (" ada", "example.com ")] {
            let good = format!("{local}@{host}");
            assert!(valid_address(&good), "{good:?} should be valid");
        }
    }

    #[test]
    fn empty_and_unsafe_subjects_are_refused() {
        let reasons = check("ada@example.com", "  ", " ").unwrap_err();
        assert!(reasons.contains(&"empty subject".to_string()));
        assert!(reasons.contains(&"empty body".to_string()));
        let reasons = check("ada@example.com", "Hi\r\nBcc: someone", "Body").unwrap_err();
        assert_eq!(reasons, vec!["line break in subject".to_string()]);
    }

    #[test]
    fn leftover_merge_tags_are_found() {
        assert_eq!(merge_tags("Hi {{first_name}}, {company} and {{ Title }}"), vec!["{{first_name}}", "{company}", "{{Title}}"]);
        // Words with spaces, plain braces, an unclosed one and CSS-like text are not tags.
        assert!(merge_tags("Hi {{first name}} { a b } {{oops").is_empty());
        assert!(merge_tags("{}").is_empty());
        let reasons = check("ada@example.com", "Hi {name}", "Dear {{First}}").unwrap_err();
        assert_eq!(reasons, vec!["unrendered merge tags: {name}, {{First}}".to_string()]);
    }

    #[test]
    fn lint_is_advice_for_style() {
        assert!(lint("Quick question", "Hello there.").is_empty());
        let advice = lint("Act now", &"word ".repeat(230));
        assert_eq!(advice.len(), 2);
        assert!(advice[1].contains("act now"));
        let links = "https://a.com (https://b.com) <http://c.com> https://d.com";
        assert!(lint("Hi", links).iter().any(|a| a.contains("4 links")));
    }
}
