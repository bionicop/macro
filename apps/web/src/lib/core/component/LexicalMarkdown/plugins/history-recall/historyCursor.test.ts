import { describe, expect, it } from 'vitest';
import { createHistoryCursor } from './historyCursor';

describe('createHistoryCursor', () => {
  it('has nowhere to go with no history', () => {
    const cursor = createHistoryCursor<string>(() => []);
    expect(cursor.previous('')).toBeUndefined();
    expect(cursor.browsing()).toBe(false);
    expect(cursor.next()).toBeUndefined();
  });

  it('walks back to the oldest entry and stops there', () => {
    const cursor = createHistoryCursor(() => ['one', 'two', 'three']);
    expect(cursor.previous('')).toBe('three');
    expect(cursor.previous('')).toBe('two');
    expect(cursor.previous('')).toBe('one');
    expect(cursor.previous('')).toBeUndefined();
    expect(cursor.browsing()).toBe(true);
  });

  it('walks forward again and ends on the draft that was being typed', () => {
    const cursor = createHistoryCursor(() => ['one', 'two']);
    expect(cursor.previous('half-typed')).toBe('two');
    expect(cursor.previous('ignored')).toBe('one');
    expect(cursor.next()).toBe('two');
    expect(cursor.next()).toBe('half-typed');
    expect(cursor.browsing()).toBe(false);
    expect(cursor.next()).toBeUndefined();
  });

  it('restores an empty draft as empty rather than skipping it', () => {
    const cursor = createHistoryCursor(() => ['one']);
    cursor.previous('');
    expect(cursor.next()).toBe('');
  });

  it('keeps the entries it started browsing with', () => {
    let entries = ['one', 'two'];
    const cursor = createHistoryCursor(() => entries);
    expect(cursor.previous('')).toBe('two');
    entries = ['one', 'two', 'three'];
    expect(cursor.previous('')).toBe('one');
    expect(cursor.next()).toBe('two');
    expect(cursor.next()).toBe('');
    // A new browse sees the newest entries.
    expect(cursor.previous('')).toBe('three');
  });

  it('starts over after reset', () => {
    const cursor = createHistoryCursor(() => ['one', 'two']);
    cursor.previous('draft');
    cursor.reset();
    expect(cursor.browsing()).toBe(false);
    expect(cursor.previous('new draft')).toBe('two');
    expect(cursor.next()).toBe('new draft');
  });

  it('carries whole entries, not just text', () => {
    const entries = [
      { value: 'see pdf', files: ['a.pdf'] },
      { value: 'plain', files: [] },
    ];
    const cursor = createHistoryCursor(() => entries);
    const draft = { value: '', files: [] };
    expect(cursor.previous(draft)).toBe(entries[1]);
    expect(cursor.previous(draft)).toBe(entries[0]);
    expect(cursor.next()).toBe(entries[1]);
    expect(cursor.next()).toBe(draft);
  });
});
