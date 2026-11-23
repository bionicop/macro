import { For } from 'solid-js';
import { TAG } from '../core/email-checks';

/**
 * A subject or line as written, with each {{field}} drawn as a quiet tag
 * instead of raw braces. For lists that describe the template, not a send.
 */
export function TemplateText(props: { text: string }) {
  const parts = () => {
    const out: { text: string; field?: boolean }[] = [];
    let last = 0;
    for (const match of props.text.matchAll(new RegExp(TAG.source, 'g'))) {
      if (match.index > last)
        out.push({ text: props.text.slice(last, match.index) });
      out.push({
        text: (match[1] ?? '').trim().replaceAll('_', ' '),
        field: true,
      });
      last = match.index + match[0].length;
    }
    if (last < props.text.length) out.push({ text: props.text.slice(last) });
    return out;
  };
  return (
    <For each={parts()}>
      {(part) =>
        part.field ? (
          <span class="rounded bg-hover px-1 text-ink-muted">{part.text}</span>
        ) : (
          part.text
        )
      }
    </For>
  );
}
