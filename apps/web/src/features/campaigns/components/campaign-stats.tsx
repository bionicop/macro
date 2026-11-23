import {
  InsightPlot,
  type InsightPlotModule,
} from '@app/features/scheduling/components/insight-plot';
import { Metric } from '@app/features/scheduling/components/insights-panel';
import type { PlotOptions } from '@observablehq/plot';
import type { CampaignDailyStatsDay } from '@service-storage/campaigns';
import { createSignal, For, type JSX, Show } from 'solid-js';

// Same grid as Insights: stacked when narrow, two by two, then one row.
const KPI_GRID =
  'grid grid-cols-1 divide-y divide-edge-muted @sm/insight-main:grid-cols-2 @3xl/insight-main:grid-cols-4 @3xl/insight-main:divide-x @3xl/insight-main:divide-y-0';

export type DailyMetric = 'sent' | 'opened' | 'replied' | 'bounced';
export type DailyCounts = Record<DailyMetric, number>;

const METRICS: DailyMetric[] = ['sent', 'opened', 'replied', 'bounced'];

const SERIES: { key: DailyMetric; label: string; color: string }[] = [
  { key: 'sent', label: 'Sent', color: 'var(--color-accent)' },
  { key: 'opened', label: 'Opened', color: 'var(--color-purple)' },
  { key: 'replied', label: 'Replied', color: 'var(--color-success)' },
  { key: 'bounced', label: 'Bounced', color: 'var(--color-failure)' },
];

const rate = (part: number, whole: number) =>
  whole ? Math.round((part / whole) * 1000) / 10 : 0;

/** Several campaigns' daily series added together, with their totals. */
export function sumDays(
  series: readonly (readonly CampaignDailyStatsDay[])[]
): {
  days: CampaignDailyStatsDay[];
  counts: DailyCounts;
} {
  const counts: DailyCounts = { sent: 0, opened: 0, replied: 0, bounced: 0 };
  const byDate = new Map<string, CampaignDailyStatsDay>();
  for (const days of series)
    for (const day of days) {
      const total = byDate.get(day.date) ?? {
        date: day.date,
        sent: 0,
        opened: 0,
        replied: 0,
        bounced: 0,
      };
      for (const key of METRICS) {
        total[key] += day[key];
        counts[key] += day[key];
      }
      byDate.set(day.date, total);
    }
  const days = [...byDate.values()].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  return { days, counts };
}

const csvCell = (value: string | number) => {
  let text = String(value);
  if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

/** One row per day, for the Download CSV action. */
export function dailyCsv(days: readonly CampaignDailyStatsDay[]) {
  return [
    ['Date', 'Sent', 'Opened', 'Replied', 'Bounced'],
    ...days.map((day) => [
      day.date,
      day.sent,
      day.opened,
      day.replied,
      day.bounced,
    ]),
  ]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n');
}

const TIP = {
  fill: 'var(--color-menu)',
  stroke: 'var(--color-edge)',
  fontSize: 12,
};
const shortDate = (date: Date) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(date);
const weekdayDate = (date: Date) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
let gradientCount = 0;

/**
 * Daily activity as soft areas under smooth lines, one per series, with a
 * crosshair tip listing every series for the day under the pointer.
 */
export function dailyPlot(
  Plot: InsightPlotModule,
  width: number,
  days: readonly CampaignDailyStatsDay[],
  series: readonly { key: DailyMetric; label: string; color: string }[],
  height: number
): PlotOptions {
  const prefix = `campaign-area-${++gradientCount}`;
  const points = days.map((day) => ({
    ...day,
    at: new Date(`${day.date}T00:00:00Z`),
  }));
  const peak = Math.max(
    4,
    ...points.flatMap((p) => series.map((s) => p[s.key]))
  );
  const tip = (p: (typeof points)[number]) =>
    [
      weekdayDate(p.at),
      ...series.map((s) => `${s.label}  ${p[s.key].toLocaleString()}`),
    ].join('\n');
  const defs = () => {
    const svg = 'http://www.w3.org/2000/svg';
    const root = document.createElementNS(svg, 'defs');
    for (const s of series) {
      const gradient = document.createElementNS(svg, 'linearGradient');
      gradient.setAttribute('id', `${prefix}-${s.key}`);
      gradient.setAttribute('x1', '0');
      gradient.setAttribute('x2', '0');
      gradient.setAttribute('y1', '0');
      gradient.setAttribute('y2', '1');
      for (const [offset, opacity] of [
        ['0%', '0.28'],
        ['100%', '0'],
      ] as const) {
        const stop = document.createElementNS(svg, 'stop');
        stop.setAttribute('offset', offset);
        stop.setAttribute('stop-color', s.color);
        stop.setAttribute('stop-opacity', opacity);
        gradient.append(stop);
      }
      root.append(gradient);
    }
    return root;
  };
  return {
    width,
    height,
    marginLeft: 36,
    marginRight: 12,
    marginTop: 8,
    marginBottom: 24,
    x: {
      type: 'utc',
      label: null,
      domain:
        points.length > 1 ? [points[0]!.at, points.at(-1)!.at] : undefined,
      ticks: Math.max(2, Math.min(points.length, Math.floor(width / 96))),
      tickFormat: shortDate,
      tickSize: 0,
    },
    y: {
      label: null,
      grid: true,
      domain: [0, peak * 1.08],
      ticks: 3,
      tickSize: 0,
      tickFormat: (value: number) =>
        Number.isInteger(value) ? value.toLocaleString() : '',
    },
    marks: [
      defs,
      ...series.flatMap((s) => [
        Plot.areaY(points, {
          x: 'at',
          y: s.key,
          curve: 'monotone-x',
          fill: `url(#${prefix}-${s.key})`,
        }),
        Plot.lineY(points, {
          x: 'at',
          y: s.key,
          curve: 'monotone-x',
          stroke: s.color,
          strokeWidth: 1.75,
        }),
      ]),
      Plot.ruleY([0], { stroke: 'var(--color-edge)' }),
      Plot.ruleX(
        points,
        Plot.pointerX({
          x: 'at',
          stroke: 'var(--color-edge)',
          strokeDasharray: '2,3',
        })
      ),
      ...series.map((s) =>
        Plot.dot(
          points,
          Plot.pointerX({
            x: 'at',
            y: s.key,
            r: 3.5,
            fill: s.color,
            stroke: 'var(--color-panel)',
            strokeWidth: 1.5,
          })
        )
      ),
      Plot.tip(
        points,
        Plot.pointerX({
          x: 'at',
          y: (p: (typeof points)[number]) =>
            Math.max(...series.map((s) => p[s.key])),
          title: tip,
          ...TIP,
        })
      ),
    ],
  };
}

const TREND_HEIGHT = 200;

const TOTAL_TILES: {
  key: DailyMetric;
  label: string;
  chart: string;
  color: string;
  definition: string;
  lowerIsBetter?: boolean;
}[] = [
  {
    key: 'sent',
    label: 'Emails sent',
    chart: 'Sent',
    color: 'var(--color-accent)',
    definition:
      'Emails sent in this period by the campaigns in view, across every step.',
  },
  {
    key: 'opened',
    label: 'Open rate',
    chart: 'Opens',
    color: 'var(--color-purple)',
    definition:
      'Opens divided by emails sent, for campaigns that track opens. Some mail apps load images on their own, so treat it as a trend rather than a count.',
  },
  {
    key: 'replied',
    label: 'Reply rate',
    chart: 'Replies',
    color: 'var(--color-success)',
    definition: 'Replies divided by emails sent.',
  },
  {
    key: 'bounced',
    label: 'Bounce rate',
    chart: 'Bounces',
    color: 'var(--color-failure)',
    definition:
      'Bounces divided by emails sent. Keep it under 2% to protect your inboxes.',
    lowerIsBetter: true,
  },
];

/**
 * The list's totals as one card: the four KPIs against the range before
 * it, and below them one chart of the days behind them. Each tile is also
 * the chart's legend entry and switches its line on or off; with sends
 * hidden the shared scale zooms in on replies and bounces.
 */
export function CampaignTotals(props: {
  days: readonly CampaignDailyStatsDay[];
  counts: DailyCounts;
  previous: DailyCounts;
}) {
  const [shown, setShown] = createSignal<DailyMetric[]>([
    'sent',
    'opened',
    'replied',
  ]);
  const isShown = (key: DailyMetric) => shown().includes(key);
  const toggle = (key: DailyMetric) =>
    setShown((current) =>
      current.includes(key)
        ? current.length > 1
          ? current.filter((k) => k !== key)
          : current
        : METRICS.filter((k) => k === key || current.includes(k))
    );
  const series = () =>
    TOTAL_TILES.filter((t) => isShown(t.key)).map((t) => ({
      key: t.key,
      label: t.chart,
      color: t.color,
    }));
  const value = (key: DailyMetric, counts: DailyCounts) =>
    key === 'sent' ? counts.sent : rate(counts[key], counts.sent);
  const any = () => props.days.some((day) => series().some((s) => day[s.key]));

  return (
    <section
      aria-label="Campaign totals"
      class="@container/insight-main overflow-hidden rounded-xl border border-edge-muted"
    >
      <div class={KPI_GRID}>
        <For each={TOTAL_TILES}>
          {(t) => (
            <Metric
              label={t.label}
              definition={t.definition}
              value={value(t.key, props.counts)}
              previous={value(t.key, props.previous)}
              unit={t.key === 'sent' ? undefined : '%'}
              lowerIsBetter={t.lowerIsBetter}
            />
          )}
        </For>
      </div>
      <div class="flex flex-col gap-2 border-t border-edge-muted px-4 pt-3 pb-1">
        <div class="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h3 class="text-sm text-ink">Per day</h3>
          {/* The legend is also the series picker, as in Plausible and Stripe. */}
          <div
            role="group"
            aria-label="Lines on the chart"
            class="flex flex-wrap items-center gap-1.5"
          >
            <For each={TOTAL_TILES}>
              {(t) => (
                <SeriesToggle
                  label={t.chart}
                  color={t.color}
                  count={props.counts[t.key]}
                  shown={isShown(t.key)}
                  onToggle={() => toggle(t.key)}
                />
              )}
            </For>
          </div>
        </div>
        <Show
          when={any()}
          fallback={
            <p
              class="grid place-items-center text-sm text-ink-extra-muted"
              style={{ height: `${TREND_HEIGHT}px` }}
            >
              Nothing sent in this period yet
            </p>
          }
        >
          <InsightPlot
            label="Activity per day"
            height={TREND_HEIGHT}
            options={(plot, width) =>
              dailyPlot(plot, width, props.days, series(), TREND_HEIGHT)
            }
          />
        </Show>
      </div>
    </section>
  );
}

/**
 * The campaigns in view over the picked range: the KPIs against the range
 * before it, then the daily activity behind them, in one card.
 */
export function CampaignStats(props: {
  days: readonly CampaignDailyStatsDay[];
  counts: DailyCounts;
  previous: DailyCounts;
  /** False when no campaign in view tracks opens; the rate reads "Not tracked". */
  opensTracked?: boolean;
  chartHeight?: number;
  /** Replaces the period KPIs above the chart, e.g. lifetime totals. */
  totals?: JSX.Element;
  /** Heading over the chart. */
  chartTitle?: string;
}) {
  const [shown, setShown] = createSignal<ReadonlySet<DailyMetric>>(
    new Set(['sent', 'replied'])
  );
  const c = () => props.counts;
  const p = () => props.previous;
  const plotted = () => SERIES.filter((series) => shown().has(series.key));
  const toggle = (key: DailyMetric) =>
    setShown((keys) => {
      const next = new Set(keys);
      if (next.has(key) && next.size > 1) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section
      aria-label="Campaign totals"
      class="@container/insight-main overflow-hidden rounded-xl border border-edge-muted"
    >
      <Show when={!props.totals} fallback={props.totals}>
        <div class={KPI_GRID}>
          <Metric
            label="Emails sent"
            definition="Emails sent in this period by the campaigns in view, across every step."
            value={c().sent}
            previous={p().sent}
          />
          <Show
            when={props.opensTracked !== false}
            fallback={
              <div class="flex flex-col gap-1 px-4 py-3">
                <span class="text-sm text-ink-muted">Open rate</span>
                <span class="text-xl text-ink-extra-muted">Not tracked</span>
              </div>
            }
          >
            <Metric
              label="Open rate"
              definition="Opens divided by emails sent, for campaigns that track opens. Some mail apps load images on their own, so treat it as a trend rather than a count."
              value={rate(c().opened, c().sent)}
              previous={rate(p().opened, p().sent)}
              unit="%"
            />
          </Show>
          <Metric
            label="Reply rate"
            definition="Replies divided by emails sent."
            value={rate(c().replied, c().sent)}
            previous={rate(p().replied, p().sent)}
            unit="%"
          />
          <Metric
            label="Bounce rate"
            definition="Bounces divided by emails sent. Keep it under 2% to protect your inboxes."
            value={rate(c().bounced, c().sent)}
            previous={rate(p().bounced, p().sent)}
            unit="%"
            lowerIsBetter
          />
        </div>
      </Show>
      <div class="flex flex-col gap-2 border-t border-edge-muted px-4 pt-3 pb-1">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm text-ink-muted">
            {props.chartTitle ?? 'Daily activity'}
          </h3>
          <fieldset class="flex flex-wrap items-center gap-1">
            <legend class="sr-only">Series to show</legend>
            <For each={SERIES}>
              {(series) => (
                <SeriesToggle
                  label={series.label}
                  color={series.color}
                  shown={shown().has(series.key)}
                  onToggle={() => toggle(series.key)}
                />
              )}
            </For>
          </fieldset>
        </div>
        <Show
          when={props.days.some((day) => day.sent > 0)}
          fallback={
            <p
              class="grid place-items-center text-sm text-ink-extra-muted"
              style={{ height: `${props.chartHeight ?? 200}px` }}
            >
              Nothing sent in this period yet
            </p>
          }
        >
          <InsightPlot
            label="Daily campaign activity"
            height={props.chartHeight ?? 200}
            options={(plot, width) =>
              dailyPlot(
                plot,
                width,
                props.days,
                plotted(),
                props.chartHeight ?? 200
              )
            }
          />
        </Show>
      </div>
    </section>
  );
}

/**
 * A chart legend entry that also hides or shows its line. Same look as the
 * series toggles on Macro's booking insights chart.
 */
function SeriesToggle(props: {
  label: string;
  color: string;
  count?: number;
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.shown}
      title={props.shown ? `Hide ${props.label}` : `Show ${props.label}`}
      onClick={props.onToggle}
      class="inline-flex items-center gap-1.5 rounded-md border border-edge-muted bg-panel px-2 py-1 text-xs text-ink-muted tabular-nums hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink"
      classList={{ 'opacity-40': !props.shown }}
    >
      <span
        aria-hidden="true"
        class="size-2 rounded-full"
        style={{ background: props.color }}
      />
      {props.label}
      <Show when={props.count !== undefined}>
        <span class="text-ink">{props.count?.toLocaleString()}</span>
      </Show>
    </button>
  );
}
