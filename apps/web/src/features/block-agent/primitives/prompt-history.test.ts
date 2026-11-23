import { describe, expect, it } from 'vitest';
import { sentPrompts } from './prompt-history';

const user = (...parts: Array<Record<string, unknown> & { kind: string }>) => ({
  author: { kind: 'user' },
  parts,
});
const text = (value: string) => ({ kind: 'text', text: value });

describe('sentPrompts', () => {
  it('lists the user prompts oldest first and skips the agent', () => {
    const prompts = sentPrompts([
      user(text('first')),
      { author: { kind: 'agent' }, parts: [text('reply')] },
      user(text('second')),
    ]);
    expect(prompts.map((p) => p.value)).toEqual(['first', 'second']);
  });

  it('drops the context block the harness prepends', () => {
    const [prompt] = sentPrompts([
      user(
        text(
          '<m-agent-context>{"version":1,"text":"<x/>"}</m-agent-context>\n\nhello there'
        )
      ),
    ]);
    expect(prompt?.value).toBe('hello there');
  });

  it('brings back the files that went with the prompt', () => {
    const [prompt] = sentPrompts([
      user(text('see attached'), {
        kind: 'attachment',
        uri: 'http://static/file/abc-123',
        name: 'brief.pdf',
        mimeType: 'application/pdf',
        size: 2048,
      }),
    ]);
    expect(prompt?.value).toBe('see attached');
    expect(prompt?.attachments).toEqual([
      {
        id: 'abc-123',
        name: 'brief.pdf',
        kind: 'document',
        mimeType: 'application/pdf',
        size: 2048,
      },
    ]);
  });

  it('keeps a prompt that is only a file, as an image chip', () => {
    const [prompt] = sentPrompts([
      user({
        kind: 'attachment',
        uri: 'http://static/file/img-1',
        name: 'shot.png',
        mimeType: 'image/png',
        size: null,
      }),
    ]);
    expect(prompt?.value).toBe('');
    expect(prompt?.attachments[0]).toMatchObject({ id: 'img-1', kind: 'image' });
  });

  it('collapses an identical prompt sent twice in a row, but not with a different file', () => {
    const file = (id: string) => ({
      kind: 'attachment',
      uri: `http://static/file/${id}`,
      name: 'a.pdf',
      mimeType: 'application/pdf',
      size: 1,
    });
    const prompts = sentPrompts([
      user(text('again')),
      user(text('again')),
      user(text('again'), file('one')),
      user(text('again'), file('two')),
    ]);
    expect(prompts).toHaveLength(3);
  });

  it('ignores a message with nothing in it', () => {
    expect(sentPrompts([user(text('   '))])).toEqual([]);
  });
});
