import { describe, expect, it } from 'vitest';
import { nameFromEmail, parsePeople } from './people';

describe('parsePeople', () => {
  it('reads one address per line, with or without a name', () => {
    const parsed = parsePeople(
      'jane@acme.com\nBob Smith <bob@globex.io>\nnot an email\n\n'
    );
    expect(parsed.people).toEqual([
      { email: 'jane@acme.com' },
      { email: 'bob@globex.io', name: 'Bob Smith' },
    ]);
    expect(parsed.skipped).toBe(1);
  });

  it('splits a comma separated list without guessing names', () => {
    expect(parsePeople('a@x.com, b@y.com; c@z.com').people).toEqual([
      { email: 'a@x.com' },
      { email: 'b@y.com' },
      { email: 'c@z.com' },
    ]);
  });

  it('uses the email and name columns of a CSV header', () => {
    const parsed = parsePeople(
      'First name,Last name,Email,Company\nJane,Doe,jane@acme.com,Acme\n"Lee, Jr",,lee@b.co,B\n,,,\nNo,Mail,,C'
    );
    expect(parsed.people).toEqual([
      { email: 'jane@acme.com', name: 'Jane Doe' },
      { email: 'lee@b.co', name: 'Lee, Jr' },
    ]);
    expect(parsed.skipped).toBe(1);
  });

  it('drops repeats, including ones already in the list', () => {
    const parsed = parsePeople('A@x.com\na@x.com\nb@x.com', [
      { email: 'b@X.com' },
    ]);
    expect(parsed.people).toEqual([{ email: 'A@x.com' }]);
    expect(parsed.duplicates).toBe(2);
  });
});

describe('nameFromEmail', () => {
  it('turns the local part into a name', () => {
    expect(nameFromEmail('jane.doe@acme.com')).toBe('Jane Doe');
    expect(nameFromEmail('bob@acme.com')).toBe('Bob');
  });
});
