import {
  CollapsibleSection,
  ListSortDropdown,
  useViewControlHotkeys,
  ViewShell,
  ViewSidebar,
} from '@app/components/view-shell';
import {
  ListHeader,
  ListHeaderSearch,
} from '@app/components/view-shell/ListHeader';
import { ViewCreateButton } from '@app/components/view-shell/ViewCreateButton';
import {
  insightPresetRange,
  previousInsightRange,
} from '@app/features/scheduling/core/insights';
import { useNavigate, usePaneHistory, useParams } from '@app/lib/split-router';
import { campaignsCampaignRoute, campaignsRoute } from '@app/routes/routes';
import { HeaderActionGroup } from '@components/app/HeaderActionGroup';
import {
  useSplitDisplayName,
  useSplitPanelOrThrow,
} from '@components/app/split-layout/layoutUtils';
import { SplitPanel } from '@components/app/split-panel';
import { useUserId } from '@core/context/user';
import { isTouchDevice } from '@core/mobile/isTouchDevice';
import { fireAndForget } from '@core/util/fireAndForget';
import BellIcon from '@icon/system/regular/bell.svg';
import CheckCircleIcon from '@icon/system/regular/check-circle.svg';
import CircleDashedIcon from '@icon/system/regular/circle-dashed.svg';
import DownloadIcon from '@icon/system/regular/download-simple.svg';
import EnvelopeIcon from '@icon/system/regular/envelope-simple.svg';
import LightningIcon from '@icon/system/regular/lightning.svg';
import PaperPlaneIcon from '@icon/system/regular/paper-plane-tilt.svg';
import PauseIcon from '@icon/system/regular/pause.svg';
import PulseIcon from '@icon/system/regular/pulse.svg';
import UsersIcon from '@icon/system/regular/users-three.svg';
import XIcon from '@icon/system/regular/x.svg';
import { Button, ButtonGroup, EmptyStatePanel, Tabs } from '@ui';
import { type Component, createMemo, createSignal, For, Show } from 'solid-js';
import { CampaignTotals, dailyCsv, sumDays } from './components/campaign-stats';
import {
  type CampaignAction,
  type CampaignSort,
  type CampaignSortKey,
  CampaignTable,
  sortCampaigns,
} from './components/campaign-table';
import { LaunchDialog } from './components/launch-dialog';
import {
  NewCampaignDialog,
  type WizardStepId,
} from './components/new-campaign-dialog';
import {
  BOUNCE_WARNING,
  type CampaignFilters,
  HEALTH_OPTIONS,
  matchesFilters,
  NO_FILTERS,
} from './core/filters';
import { toCampaignRow } from './core/rows';
import type { CampaignStatus } from './core/sample';
import type { CampaignSection } from './core/sections';
import {
  useCampaignsQuery,
  useLaunchCampaign,
  usePauseCampaign,
  useTrashCampaign,
} from './queries';
import { useDuplicateCampaign } from './queries/duplicate';
import {
  useCampaignsDailyQueries,
  useCampaignsStatsQueries,
} from './queries/list-stats';
import { CampaignRecord } from './views/campaign-record';

type CampaignView = 'all' | CampaignStatus;
type SendingView = 'inboxes' | 'domains' | 'warmup';
type View = CampaignView | SendingView;

const CAMPAIGN_VIEWS: {
  id: CampaignView;
  label: string;
  icon: Component<{ class?: string }>;
}[] = [
  { id: 'all', label: 'All campaigns', icon: PaperPlaneIcon },
  { id: 'active', label: 'Sending', icon: PulseIcon },
  { id: 'paused', label: 'Paused', icon: PauseIcon },
  { id: 'draft', label: 'Drafts', icon: CircleDashedIcon },
  { id: 'completed', label: 'Completed', icon: CheckCircleIcon },
];

const SENDING_VIEWS: {
  id: SendingView;
  label: string;
  icon: Component<{ class?: string }>;
}[] = [
  { id: 'inboxes', label: 'Inboxes', icon: EnvelopeIcon },
  { id: 'domains', label: 'Domains', icon: UsersIcon },
  { id: 'warmup', label: 'Warmup', icon: LightningIcon },
];

const isSendingView = (view: View): view is SendingView =>
  SENDING_VIEWS.some((item) => item.id === view);

export function CampaignsWorkspace() {
  const panel = useSplitPanelOrThrow();
  useSplitDisplayName(() => 'Campaigns');
  let focusSearch: (() => void) | undefined;
  useViewControlHotkeys({
    scopeId: panel.splitHotkeyScope,
    enabled: () => panel.isPanelActive() && !isTouchDevice(),
    search: {
      description: 'Search campaigns',
      run: () => {
        focusSearch?.();
        return Boolean(focusSearch);
      },
    },
  });

  const [view, setView] = createSignal<View>('all');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [range, setRange] = createSignal(
    insightPresetRange(30, timeZone, new Date())
  );
  const PRESETS = ['7', '30', '90'] as const;
  const preset = () =>
    PRESETS.find((days) => {
      const r = insightPresetRange(Number(days), timeZone, new Date());
      return r.from === range().from && r.to === range().to;
    });
  // + New, or Continue setup on a draft: the same full-size editor.
  const [wizard, setWizard] = createSignal<{
    campaignId?: string;
    startAt?: WizardStepId;
  }>();
  const downloadCsv = () => {
    const { from, to } = range();
    const csv = dailyCsv(totals().days);
    const url = URL.createObjectURL(
      new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `campaigns-${from}-${to}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const [sort, setSort] = createSignal<CampaignSort>({
    key: 'recent',
    reversed: false,
  });
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const userId = useUserId();
  const [filters, setFilters] = createSignal<CampaignFilters>(NO_FILTERS);
  const setFilter = <K extends keyof CampaignFilters>(
    key: K,
    value: CampaignFilters[K]
  ) => setFilters((current) => ({ ...current, [key]: value }));
  const list = useCampaignsQuery();
  const ids = createMemo(() =>
    (list.data ?? []).map((campaign) => campaign.id)
  );
  const stats = useCampaignsStatsQueries(ids);
  // The picked range and the one before it, for the KPIs' comparison.
  const daily = useCampaignsDailyQueries(ids, () => ({
    ...range(),
    tz: timeZone,
  }));
  const dailyBefore = useCampaignsDailyQueries(ids, () => ({
    ...previousInsightRange(range()),
    tz: timeZone,
  }));
  const daysById = (queries: typeof daily) =>
    new Map(ids().map((id, index) => [id, queries[index]?.data?.days ?? []]));
  const campaigns = createMemo(() => {
    const days = daysById(daily);
    return (list.data ?? []).map((campaign, index) => ({
      ...toCampaignRow(campaign, stats[index]?.data),
      // The row's sparkline: the last two weeks of the picked range.
      daily: (days.get(campaign.id) ?? []).slice(-14).map((day) => day.sent),
    }));
  });
  const launch = useLaunchCampaign();
  const [launching, setLaunching] = createSignal<string>();
  const pause = usePauseCampaign();
  const trash = useTrashCampaign();
  const duplicate = useDuplicateCampaign();
  const sortBy = (key: CampaignSortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, reversed: !current.reversed }
        : { key, reversed: false }
    );
  const act = (ids: string[], action: CampaignAction) => {
    if (action === 'open') return openCampaign(ids[0]);
    for (const id of ids) {
      if (action === 'pause') pause.mutate({ id });
      else if (action === 'launch' && ids.length === 1) setLaunching(id);
      else if (action === 'resume' || action === 'launch')
        launch.mutate({ id });
      else if (action === 'delete') trash.mutate({ id });
      else if (action === 'duplicate') duplicate(id);
    }
    if (action === 'delete') {
      setSelected(new Set<string>());
      if (openId() && ids.includes(openId() as string)) closeCampaign();
    }
  };
  const [query, setQuery] = createSignal('');
  const [sendingOpen, setSendingOpen] = createSignal(true);
  // The open campaign and its tab live in the URL, so links and history work.
  const params = useParams<{
    campaignId?: string;
    section?: CampaignSection;
    stepId?: string;
  }>();
  const navigate = useNavigate();
  const history = usePaneHistory();
  const openId = () => params.campaignId;
  const section = (): CampaignSection => params.section ?? 'overview';
  const go = (campaignId: string, next: CampaignSection, stepId?: string) =>
    fireAndForget(
      navigate({
        route: campaignsCampaignRoute,
        params: { campaignId, section: next, stepId },
      }),
      'campaigns'
    );
  const openCampaign = (id: string) => go(id, 'overview');
  const setSection = (next: CampaignSection) => {
    const id = openId();
    if (id) go(id, next);
  };
  /** Back to the list, through history when the list is where we came from. */
  const closeCampaign = () => {
    if (!openId()) return;
    const snapshot = history();
    if (snapshot) {
      for (let index = snapshot.index - 1; index >= 0; index--) {
        const matches = snapshot.entries[index].location.route.matches;
        if (!matches.some((match) => match.id === campaignsRoute.id)) break;
        if (matches.at(-1)?.id === campaignsRoute.id) {
          fireAndForget(navigate(index - snapshot.index), 'campaigns');
          return;
        }
      }
    }
    fireAndForget(navigate({ route: campaignsRoute, params: {} }), 'campaigns');
  };
  const opened = createMemo(() =>
    campaigns().find((campaign) => campaign.id === openId())
  );

  const countOf = (id: CampaignView) =>
    id === 'all'
      ? campaigns().length
      : campaigns().filter((campaign) => campaign.status === id).length;

  const shown = createMemo(() => {
    const current = view();
    const needle = query().trim().toLowerCase();
    const filtered = campaigns().filter(
      (campaign) =>
        (current === 'all' || campaign.status === current) &&
        matchesFilters(campaign, filters(), userId()) &&
        (!needle ||
          campaign.name.toLowerCase().includes(needle) ||
          campaign.audience.toLowerCase().includes(needle))
    );
    return sortCampaigns(filtered, sort());
  });
  /** Totals for the campaigns the list is showing, so filters move them. */
  const totals = createMemo(() => {
    const days = daysById(daily);
    return sumDays(shown().map((campaign) => days.get(campaign.id) ?? []));
  });
  const totalsBefore = createMemo(() => {
    const days = daysById(dailyBefore);
    return sumDays(shown().map((campaign) => days.get(campaign.id) ?? []))
      .counts;
  });

  const title = () =>
    [...CAMPAIGN_VIEWS, ...SENDING_VIEWS].find((item) => item.id === view())
      ?.label ?? 'Campaigns';

  return (
    <SplitPanel.Root>
      <SplitPanel.Body>
        <ViewShell.Root
          asidePreferenceKey="campaigns"
          aside={isTouchDevice() ? false : undefined}
          resizable={!isTouchDevice()}
          main={{ preferredWidth: 960 }}
        >
          <ViewShell.Aside>
            <ViewSidebar.Root aria-label="Campaigns navigation">
              <ViewSidebar.Header>
                <div class="flex min-w-0 items-center gap-1">
                  <ViewSidebar.CloseButton />
                  <ViewSidebar.Title>Campaigns</ViewSidebar.Title>
                </div>
              </ViewSidebar.Header>
              <ViewSidebar.Content>
                <ViewSidebar.Nav aria-label="Campaigns">
                  <For each={CAMPAIGN_VIEWS}>
                    {(item) => (
                      <ViewSidebar.Item
                        active={!opened() && view() === item.id}
                        onClick={() => {
                          closeCampaign();
                          setView(item.id);
                        }}
                      >
                        <ViewSidebar.Icon>
                          <item.icon />
                        </ViewSidebar.Icon>
                        <span class="truncate">{item.label}</span>
                        <ViewSidebar.Trailing class="text-xs tabular-nums text-ink-extra-muted">
                          {countOf(item.id)}
                        </ViewSidebar.Trailing>
                      </ViewSidebar.Item>
                    )}
                  </For>
                </ViewSidebar.Nav>
                <CollapsibleSection
                  open={sendingOpen()}
                  onOpenChange={setSendingOpen}
                >
                  <CollapsibleSection.Header>
                    <CollapsibleSection.Trigger>
                      Sending
                      <CollapsibleSection.Indicator />
                    </CollapsibleSection.Trigger>
                  </CollapsibleSection.Header>
                  <CollapsibleSection.Content>
                    <ViewSidebar.Nav aria-label="Sending">
                      <For each={SENDING_VIEWS}>
                        {(item) => (
                          <ViewSidebar.Item
                            active={!opened() && view() === item.id}
                            onClick={() => {
                              closeCampaign();
                              setView(item.id);
                            }}
                          >
                            <ViewSidebar.Icon>
                              <item.icon />
                            </ViewSidebar.Icon>
                            <span class="truncate">{item.label}</span>
                          </ViewSidebar.Item>
                        )}
                      </For>
                    </ViewSidebar.Nav>
                  </CollapsibleSection.Content>
                </CollapsibleSection>
              </ViewSidebar.Content>
            </ViewSidebar.Root>
          </ViewShell.Aside>
          <ViewShell.Main>
            <Show when={opened()} fallback={listView()}>
              {(campaign) => (
                <CampaignRecord
                  campaign={campaign()}
                  section={section()}
                  viewName={title()}
                  onSectionChange={setSection}
                  stepId={params.stepId}
                  onOpenStep={(stepId) => go(campaign().id, 'overview', stepId)}
                  onClose={closeCampaign}
                  onEdit={() =>
                    setWizard({ campaignId: campaign().id, startAt: 'review' })
                  }
                  onAction={(action) => act([campaign().id], action)}
                />
              )}
            </Show>
          </ViewShell.Main>
        </ViewShell.Root>
      </SplitPanel.Body>
      <LaunchDialog
        campaignId={launching()}
        name={campaigns().find((c) => c.id === launching())?.name ?? 'campaign'}
        onClose={() => setLaunching(undefined)}
        onFix={(next) => {
          const id = launching();
          if (id) go(id, next);
        }}
      />
      <NewCampaignDialog
        open={Boolean(wizard())}
        campaignId={wizard()?.campaignId}
        startAt={wizard()?.startAt}
        onClose={() => setWizard(undefined)}
        onOpen={go}
      />
    </SplitPanel.Root>
  );

  /** What wants a decision, the way the old Command Center opened. */
  function NeedsYou() {
    const paused = () =>
      campaigns().filter((c) => c.status === 'paused').length;
    const empty = () =>
      campaigns().filter((c) => c.status === 'draft' && !c.people).length;
    const bouncing = () =>
      campaigns().filter((c) => c.sent && c.bounced / c.sent > BOUNCE_WARNING)
        .length;
    const sending = () =>
      campaigns().filter((c) => c.status === 'active').length;
    const Item = (props: {
      count: number;
      text: string;
      onClick?: () => void;
      tone?: string;
    }) => (
      <Show when={props.count > 0}>
        <button
          type="button"
          disabled={!props.onClick}
          onClick={props.onClick}
          class={`flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm text-ink-muted enabled:not-touch:hover:bg-hover enabled:not-touch:hover:text-ink ${props.tone ?? ''}`}
        >
          <span class="font-semibold text-ink tabular-nums">
            {props.count.toLocaleString()}
          </span>
          {props.text}
        </button>
      </Show>
    );
    return (
      <Show when={campaigns().length > 0}>
        <div
          role="status"
          class="flex min-h-11 flex-wrap items-center gap-x-1 gap-y-1 rounded-xl border border-edge-muted px-3 py-1.5"
        >
          <BellIcon class="mr-1 size-4 shrink-0 text-ink-muted" />
          <Item
            count={totals().counts.replied}
            text={`${totals().counts.replied === 1 ? 'reply' : 'replies'} in the last ${(Date.parse(range().to) - Date.parse(range().from)) / 86400000 + 1} days`}
            onClick={() => setFilter('health', 'replies')}
          />
          <Item
            count={sending()}
            text="sending now"
            onClick={() => setView('active')}
          />
          <Item
            count={paused()}
            text="paused"
            onClick={() => setView('paused')}
            tone="[&>span]:text-warning"
          />
          <Item
            count={bouncing()}
            text={`${bouncing() === 1 ? 'is' : 'are'} bouncing over 2%`}
            onClick={() => setFilter('health', 'bouncing')}
            tone="[&>span]:text-failure"
          />
          <Item
            count={empty()}
            text={`${empty() === 1 ? 'draft has' : 'drafts have'} no people yet`}
            onClick={() => setView('draft')}
          />
        </div>
      </Show>
    );
  }

  function listView() {
    return (
      <>
        <ListHeader
          title={
            <div class="flex min-w-0 items-center gap-2">
              <ViewSidebar.Title caret={false} class="pl-2">
                {title()}
              </ViewSidebar.Title>
              <Show when={!isSendingView(view())}>
                <span class="shrink-0 text-sm tabular-nums text-ink-extra-muted">
                  {shown().length}
                </span>
              </Show>
              <Show when={filters().health !== 'all'}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label="Clear filter"
                  onClick={() => setFilters(NO_FILTERS)}
                >
                  {
                    HEALTH_OPTIONS.find(
                      (option) => option.value === filters().health
                    )?.label
                  }
                  <XIcon class="size-3.5" aria-hidden="true" />
                </Button>
              </Show>
            </div>
          }
        >
          <Show when={!isSendingView(view())}>
            <Tabs
              aria-label="Period"
              size="sm"
              value={preset()}
              onChange={(days) =>
                setRange(insightPresetRange(Number(days), timeZone, new Date()))
              }
              options={PRESETS.map((days) => ({
                value: days,
                label: `${days}d`,
              }))}
            />
            <HeaderActionGroup label="Campaign view options">
              <ButtonGroup.Button
                aria-label="Download CSV"
                tooltip="Download CSV"
                variant="ghost"
                size="icon-sm"
                onClick={downloadCsv}
                disabled={shown().length === 0}
              >
                <DownloadIcon class="size-4 shrink-0 pointer-events-none" />
              </ButtonGroup.Button>
              <ListSortDropdown
                grouped
                label="Sort campaigns"
                value={sort().key}
                options={[
                  { id: 'recent', label: 'Recently active' },
                  { id: 'name', label: 'Name' },
                  { id: 'progress', label: 'Progress' },
                  { id: 'replies', label: 'Most replies' },
                  { id: 'opens', label: 'Open rate' },
                  { id: 'bounce', label: 'Bounce rate' },
                ]}
                onChange={(key) => setSort({ key, reversed: false })}
              />
            </HeaderActionGroup>
            <ViewCreateButton
              presentation="toolbar"
              aria-label="New campaign"
              onClick={() => setWizard({})}
            />
            <ListHeaderSearch
              label="Search campaigns"
              value={query()}
              onValueChange={setQuery}
              registerFocus={(focus) => (focusSearch = focus)}
            />
          </Show>
        </ListHeader>
        <div class="@container/campaigns min-h-0 flex-1 overflow-y-auto">
          <Show
            when={!isSendingView(view())}
            fallback={
              <EmptyStatePanel
                centered
                title={title()}
                description="Connected inboxes, their domains and warmup will show here."
              />
            }
          >
            <div class="flex w-full flex-col gap-3 px-3 pt-1 pb-8">
              <NeedsYou />
              <CampaignTotals
                days={totals().days}
                counts={totals().counts}
                previous={totalsBefore()}
              />
              <Show
                when={shown().length || list.isPending}
                fallback={
                  <EmptyStatePanel
                    centered
                    title={
                      query().trim()
                        ? 'No campaigns match your search'
                        : 'No campaigns here yet'
                    }
                  />
                }
              >
                <CampaignTable
                  campaigns={shown()}
                  sort={sort()}
                  onSort={sortBy}
                  selected={selected()}
                  onSelectedChange={setSelected}
                  onOpen={openCampaign}
                  onAction={act}
                />
              </Show>
            </div>
          </Show>
        </div>
      </>
    );
  }
}
