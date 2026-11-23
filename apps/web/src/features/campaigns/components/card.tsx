import { cn } from '@ui';
import { type JSX, Show } from 'solid-js';

/** A titled, bordered block on a campaign's Overview and Insights tabs. */
export function Card(props: {
  title: string;
  description?: string;
  actions?: JSX.Element;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <section
      aria-label={props.title}
      class={cn(
        'flex min-w-0 flex-col rounded-xl border border-edge-muted',
        props.class
      )}
    >
      <header class="flex min-h-11 items-center justify-between gap-3 px-4 pt-2">
        <div class="min-w-0">
          <h2 class="truncate text-sm font-medium">{props.title}</h2>
          <Show when={props.description}>
            <p class="truncate text-xs text-ink-muted">{props.description}</p>
          </Show>
        </div>
        {props.actions}
      </header>
      {props.children}
    </section>
  );
}
