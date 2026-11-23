// Merge fields and the checks shown while an email is written. Field rules
// mirror `crates/campaign/src/domain/template.rs`: `{{Field}}` or
// `{{Field|fallback}}`, case-insensitive, `_` read as a space.

/** Fields every person has, in the order the insert menu offers them. */
export const MERGE_FIELDS = [
  { tag: '{{first_name|there}}', label: 'First name', name: 'first name' },
  { tag: '{{name}}', label: 'Full name', name: 'name' },
  { tag: '{{email}}', label: 'Email', name: 'email' },
  {
    tag: '{{unsubscribe_link}}',
    label: 'Unsubscribe link',
    name: 'unsubscribe link',
  },
] as const;

const BUILT_IN = new Set<string>(MERGE_FIELDS.map((field) => field.name));
export const TAG = /\{\{([^{}|]*)(?:\|([^{}]*))?\}\}/g;

export const normalizeField = (name: string) =>
  name.replaceAll('_', ' ').trim().split(/\s+/).join(' ').toLowerCase();

/** The person the preview is written to. */
export const SAMPLE_PERSON: Record<string, string> = {
  'first name': 'Jane',
  name: 'Jane Cooper',
  email: 'jane@acme.com',
  'unsubscribe link': 'https://macro.com/u/…',
};

/** Fills each field from `values`, then its fallback, then `[Field]`. */
export function fillFields(
  text: string,
  values: Record<string, string> = SAMPLE_PERSON
): string {
  return text.replace(TAG, (_, name: string, fallback?: string) => {
    const value = values[normalizeField(name)];
    return value || fallback?.trim() || `[${name.trim()}]`;
  });
}

/** Fields with no built-in value and no fallback: they need a column. */
export function unknownFields(text: string): string[] {
  const found = new Set<string>();
  for (const [, name, fallback] of text.matchAll(TAG)) {
    const field = normalizeField(name ?? '');
    if (field && !BUILT_IN.has(field) && fallback === undefined)
      found.add(name!.trim());
  }
  return [...found];
}

// Words cold-email tools flag most often; a short list, not a filter.
const SPAM_WORDS = [
  'free',
  'guarantee',
  'guaranteed',
  'act now',
  'limited time',
  'urgent',
  'winner',
  'risk-free',
  'no obligation',
  'click here',
  '100%',
  'cash',
  'buy now',
  'special promotion',
  'earn money',
];

export type CheckLevel = 'good' | 'warning' | 'problem';
export type EmailCheck = { level: CheckLevel; label: string };

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);

/** What to fix or improve in one email, best first problem first. */
export function checkEmail(input: {
  subject: string;
  body: string;
  /** Follow-ups may leave the subject empty to reply in the thread. */
  first: boolean;
}): EmailCheck[] {
  const checks: EmailCheck[] = [];
  const count = words(input.body).length;
  const all = `${input.subject}\n${input.body}`;

  if (!input.body.trim())
    checks.push({ level: 'problem', label: 'Write a message' });
  if (input.first && !input.subject.trim())
    checks.push({ level: 'problem', label: 'Add a subject' });
  for (const field of unknownFields(all))
    checks.push({
      level: 'problem',
      label: `{{${field}}} needs a column named “${field}”, or a fallback like {{${field}|there}}`,
    });

  if (input.subject.length > 60)
    checks.push({
      level: 'warning',
      label: 'Shorten the subject; under 60 characters reads best on phones',
    });
  if (count > 150)
    checks.push({
      level: 'warning',
      label: `${count} words. Cold emails under 125 get more replies`,
    });
  const links = (input.body.match(/https?:\/\//g) ?? []).length;
  if (links > 1)
    checks.push({
      level: 'warning',
      label: `${links} links. One or none keeps it out of spam`,
    });
  const lower = all.toLowerCase();
  const spammy = SPAM_WORDS.filter((word) =>
    new RegExp(
      `(^|\\W)${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\W)`
    ).test(lower)
  );
  if (spammy.length)
    checks.push({
      level: 'warning',
      label: `Spam-filter words: ${spammy.map((w) => `“${w}”`).join(', ')}`,
    });
  if (
    input.subject &&
    input.subject === input.subject.toUpperCase() &&
    /[A-Z]/.test(input.subject)
  )
    checks.push({ level: 'warning', label: 'Avoid an all-caps subject' });

  if (!checks.length && count)
    checks.push({
      level: 'good',
      label: `${count} words, ready to send`,
    });
  return checks;
}
