import { describe, expect, it } from 'vitest';
import { checkEmail, fillFields, unknownFields } from './email-checks';

describe('fillFields', () => {
  it('fills built-ins, then fallbacks, then names the field', () => {
    expect(
      fillFields('Hi {{First_Name|there}}, {{company|your team}} {{role}}')
    ).toBe('Hi Jane, your team [role]');
    expect(fillFields('Hi {{first name|there}}', {})).toBe('Hi there');
  });
});

describe('unknownFields', () => {
  it('lists fields without a built-in value or a fallback', () => {
    expect(
      unknownFields('{{first_name}} {{company}} {{role|you}} {{Email}}')
    ).toEqual(['company']);
  });
});

describe('checkEmail', () => {
  it('blocks an empty first email', () => {
    const labels = checkEmail({ subject: '', body: '', first: true }).map(
      (c) => c.label
    );
    expect(labels).toEqual(['Write a message', 'Add a subject']);
  });

  it('lets a follow-up reply in the thread', () => {
    expect(
      checkEmail({ subject: '', body: 'Any thoughts?', first: false })
    ).toEqual([{ level: 'good', label: '2 words, ready to send' }]);
  });

  it('warns on spam words, links and caps', () => {
    const checks = checkEmail({
      subject: 'FREE TRIAL',
      body: 'Click here https://a.com and https://b.com, guaranteed.',
      first: true,
    });
    expect(checks.map((c) => c.level)).toEqual([
      'warning',
      'warning',
      'warning',
    ]);
    expect(checks[1]!.label).toContain('“free”');
  });
});
