import { cn } from '@ui';

/** A small trend line with a soft fill, scaled to its box. Decorative. */
export function Sparkline(props: { values: number[]; class?: string }) {
  const points = () => {
    const values = props.values.length > 1 ? props.values : [0, 0];
    const peak = Math.max(1, ...values);
    const step = 100 / (values.length - 1);
    return values.map(
      (value, index) => [index * step, 30 - (value / peak) * 26 - 2] as const
    );
  };
  const line = () =>
    points()
      .map(([x, y]) => `${x},${y}`)
      .join(' ');
  const area = () => `0,30 ${line()} 100,30`;

  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
      class={cn('overflow-visible', props.class)}
    >
      <polygon points={area()} class="fill-accent/10" />
      <polyline
        points={line()}
        fill="none"
        stroke-width="1.5"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
        class="stroke-accent"
      />
    </svg>
  );
}

/** A thin horizontal meter; the fill is a share of the track. Decorative. */
export function Meter(props: { value: number; max: number; class?: string }) {
  const share = () =>
    props.max > 0 ? Math.min(100, (props.value / props.max) * 100) : 0;
  return (
    <div
      aria-hidden="true"
      class={cn('h-1 overflow-hidden rounded-full bg-edge-muted', props.class)}
    >
      <div
        class="h-full rounded-full bg-accent motion-safe:transition-[width]"
        style={{ width: `${share()}%` }}
      />
    </div>
  );
}
