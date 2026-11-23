import { throwOnErr } from '@core/util/result';
import { queryClient } from '@queries/client';
import {
  type AccessibleCampaign,
  type CampaignDailyRange,
  type CampaignSender,
  type CampaignSendgridAccount,
  type CampaignSendingIdentity,
  type CampaignSettings,
  type CampaignStep,
  type CampaignStepInput,
  type CreateCampaign,
  campaignsClient,
  type LaunchOutcome,
} from '@service-storage/campaigns';
import {
  infiniteQueryOptions,
  queryOptions,
  type SolidMutationOptions,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
} from '@tanstack/solid-query';
import type { Accessor } from 'solid-js';
import {
  addCampaignPeople,
  type PeopleTable,
  type Person,
} from '../core/people';
import { campaignKeys } from './keys';
import {
  LAUNCHED_STATUS,
  PAUSED_STATUS,
  patchCampaignInList,
  removeCampaignFromList,
} from './mapping';

/* ---------------------------------- reads --------------------------------- */

function campaignListOptions() {
  return queryOptions({
    queryKey: campaignKeys.list.queryKey,
    queryFn: () => throwOnErr(() => campaignsClient.list()),
  });
}

function campaignOptions(id: string | undefined) {
  return queryOptions({
    queryKey: campaignKeys.detail(id ?? '').queryKey,
    queryFn: () => throwOnErr(() => campaignsClient.get(id as string)),
    enabled: !!id,
  });
}

function campaignStepsOptions(id: string | undefined) {
  return queryOptions({
    queryKey: campaignKeys.steps(id ?? '').queryKey,
    queryFn: () => throwOnErr(() => campaignsClient.getSteps(id as string)),
    enabled: !!id,
  });
}

function campaignCheckOptions(id: string | undefined) {
  return queryOptions({
    queryKey: campaignKeys.check(id ?? '').queryKey,
    queryFn: () => throwOnErr(() => campaignsClient.check(id as string)),
    enabled: !!id,
    // Always re-ask: a fix in another tab must clear the problem here.
    staleTime: 0,
  });
}

function campaignSendersOptions(id: string | undefined) {
  return queryOptions({
    queryKey: campaignKeys.senders(id ?? '').queryKey,
    queryFn: () => throwOnErr(() => campaignsClient.getSenders(id as string)),
    enabled: !!id,
  });
}

function campaignStatsOptions(id: string | undefined) {
  return queryOptions({
    queryKey: campaignKeys.stats(id ?? '').queryKey,
    queryFn: () => throwOnErr(() => campaignsClient.getStats(id as string)),
    enabled: !!id,
    // Counts move while a campaign sends.
    staleTime: 30_000,
  });
}

function campaignDailyStatsOptions(
  id: string | undefined,
  { from, to, tz }: CampaignDailyRange
) {
  return queryOptions({
    queryKey: campaignKeys.dailyStats(id ?? '', from, to, tz).queryKey,
    queryFn: () =>
      throwOnErr(() =>
        campaignsClient.getDailyStats(id as string, { from, to, tz })
      ),
    enabled: !!id,
    staleTime: 30_000,
  });
}

function allCampaignsDailyStatsOptions({ from, to, tz }: CampaignDailyRange) {
  return queryOptions({
    queryKey: campaignKeys.allDailyStats(from, to, tz).queryKey,
    queryFn: () =>
      throwOnErr(() => campaignsClient.getAllDailyStats({ from, to, tz })),
    staleTime: 30_000,
  });
}

function campaignRecipientsOptions(id: string | undefined) {
  return infiniteQueryOptions({
    queryKey: campaignKeys.recipients(id ?? '').queryKey,
    queryFn: ({ pageParam }) =>
      throwOnErr(() =>
        campaignsClient.getRecipients(id as string, pageParam ?? null)
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next,
    enabled: !!id,
  });
}

function campaignIdentitiesOptions() {
  return queryOptions({
    queryKey: campaignKeys.identities.queryKey,
    queryFn: () => throwOnErr(() => campaignsClient.listIdentities()),
  });
}

/** The caller's live campaigns, with their grant. */
export function useCampaignsQuery() {
  return useQuery(() => campaignListOptions());
}

/** One campaign; disabled while `id()` is undefined. */
export function useCampaignQuery(id: Accessor<string | undefined>) {
  return useQuery(() => campaignOptions(id()));
}

/** The sequence in order. */
export function useCampaignStepsQuery(id: Accessor<string | undefined>) {
  return useQuery(() => campaignStepsOptions(id()));
}

/** The sender rotation. */
export function useCampaignSendersQuery(id: Accessor<string | undefined>) {
  return useQuery(() => campaignSendersOptions(id()));
}

/**
 * Senders of several campaigns at once, read by campaign id; undefined until
 * that campaign's senders load.
 */
export function useSendingCampaignSenders(ids: Accessor<readonly string[]>) {
  const queries = useQueries(() => ({
    queries: ids().map((id) => campaignSendersOptions(id)),
  }));
  return (id: string) => {
    const at = ids().indexOf(id);
    return at < 0 ? undefined : queries[at]?.data;
  };
}

/** Recipient and send counts, with per-step counts. */
export function useCampaignStatsQuery(id: Accessor<string | undefined>) {
  return useQuery(() => campaignStatsOptions(id()));
}

/** Sent, opened, replied and bounced per day for one campaign. */
export function useCampaignDailyStatsQuery(
  id: Accessor<string | undefined>,
  range: Accessor<CampaignDailyRange>
) {
  return useQuery(() => campaignDailyStatsOptions(id(), range()));
}

/** The daily series summed over every campaign the caller can see. */
export function useAllCampaignsDailyStatsQuery(
  range: Accessor<CampaignDailyRange>
) {
  return useQuery(() => allCampaignsDailyStatsOptions(range()));
}

/**
 * Enrolled recipients, a page at a time (`fetchNextPage` / `hasNextPage`).
 * Pages are in `data.pages[n].recipients`.
 */
export function useCampaignRecipientsQuery(id: Accessor<string | undefined>) {
  return useInfiniteQuery(() => campaignRecipientsOptions(id()));
}

/** Rows read for a count before giving up and showing "N+". */
export const ROW_COUNT_LIMIT = 5000;

/**
 * How many people are in the campaign's table, enrolled or not. Recipients
 * only exist once a launch enrolls them, so a draft counts rows instead.
 */
export function useCampaignRowCountQuery(id: Accessor<string | undefined>) {
  return useQuery(() => ({
    queryKey: campaignKeys.rowCount(id() ?? '').queryKey,
    enabled: !!id(),
    queryFn: async () => {
      let count = 0;
      let after: string | null = null;
      do {
        const page = await throwOnErr(() =>
          campaignsClient.getRows(id() as string, after)
        );
        count += page.rows.length;
        after = page.next;
      } while (after && count < ROW_COUNT_LIMIT);
      return { count, more: Boolean(after) };
    },
  }));
}

/** `mutateAsync({ campaign, people })`; see {@link addCampaignPeople}. */
export function useAddCampaignPeople() {
  return useMutation(() => ({
    mutationFn: ({
      campaign,
      people,
    }: {
      campaign: PeopleTable;
      people: readonly Person[];
    }) => addCampaignPeople(campaign, people),
    onSettled: (_data, _error, { campaign }) =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: campaignKeys.rowCount(campaign.id).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: campaignKeys.recipients(campaign.id).queryKey,
        }),
      ]),
  }));
}

/** The caller's SMTP and SendGrid sending identities. */
export function useCampaignIdentitiesQuery() {
  return useQuery(() => campaignIdentitiesOptions());
}

/** The connected SendGrid account and the domains it may send from. */
export function useSendgridQuery() {
  return useQuery(() => ({
    queryKey: campaignKeys.sendgrid.queryKey,
    queryFn: () => throwOnErr(() => campaignsClient.getSendgrid()),
    staleTime: 60_000,
    retry: false,
  }));
}

/** `mutateAsync(apiKey)`. Checks and stores the key, returns the account. */
export function useConnectSendgrid() {
  return useMutation(() => ({
    mutationFn: (apiKey: string) =>
      throwOnErr(() => campaignsClient.connectSendgrid(apiKey)),
    onSuccess: (account: CampaignSendgridAccount) =>
      queryClient.setQueryData(campaignKeys.sendgrid.queryKey, account),
  }));
}

/** `mutateAsync({ fromEmail })`. A SendGrid sender for that address. */
export function useAddSendgridSender() {
  return useMutation(() => ({
    mutationFn: (input: { fromEmail: string; fromName?: string | null }) =>
      throwOnErr(() => campaignsClient.addSendgridSender(input)),
    onSuccess: (created: CampaignSendingIdentity) =>
      queryClient.setQueryData<CampaignSendingIdentity[]>(
        campaignKeys.identities.queryKey,
        (list) => [
          ...(list ?? []).filter(
            (identity) =>
              identity.fromEmail.toLowerCase() !==
              created.fromEmail.toLowerCase()
          ),
          created,
        ]
      ),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: campaignKeys.identities.queryKey,
      }),
  }));
}

const LIVE_REFRESH_MS = 15_000;

/**
 * The latest events, newest first. `live()` polls while the campaign sends;
 * an older server without the route leaves `isError` set and the feed empty.
 */
export function useCampaignEventsQuery(
  id: Accessor<string | undefined>,
  live: Accessor<boolean> = () => false
) {
  return useQuery(() => ({
    queryKey: campaignKeys.events(id() ?? '').queryKey,
    queryFn: () => throwOnErr(() => campaignsClient.getEvents(id() as string)),
    enabled: !!id(),
    retry: false,
    refetchInterval: live() ? LIVE_REFRESH_MS : false,
  }));
}

/** Answers drafted for replies, waiting for review. */
export function useCampaignReplyDraftsQuery(id: Accessor<string | undefined>) {
  return useQuery(() => ({
    queryKey: campaignKeys.replyDrafts(id() ?? '').queryKey,
    queryFn: () =>
      throwOnErr(() => campaignsClient.getReplyDrafts(id() as string)),
    enabled: !!id(),
    retry: false,
  }));
}

export function useUpdateReplyDraft() {
  return useMutation(() => ({
    mutationFn: (input: {
      id: string;
      draftId: string;
      patch: Parameters<typeof campaignsClient.updateReplyDraft>[2];
    }) =>
      throwOnErr(() =>
        campaignsClient.updateReplyDraft(input.id, input.draftId, input.patch)
      ),
    onSettled: (_data, _error, input) =>
      queryClient.invalidateQueries({
        queryKey: campaignKeys.replyDrafts(input.id).queryKey,
      }),
  }));
}

/* ------------------------------ cache helpers ----------------------------- */

type Rollback = { rollback: () => void };

/** Update the list and detail caches now; `rollback` restores them. */
async function patchCampaignCaches(
  id: string,
  patch: Partial<AccessibleCampaign>
): Promise<Rollback> {
  const listKey = campaignKeys.list.queryKey;
  const detailKey = campaignKeys.detail(id).queryKey;
  // A fetch that started before this change must not overwrite it.
  await Promise.all([
    queryClient.cancelQueries({ queryKey: listKey }),
    queryClient.cancelQueries({ queryKey: detailKey }),
  ]);
  const list = queryClient.getQueryData<AccessibleCampaign[]>(listKey);
  const detail = queryClient.getQueryData<AccessibleCampaign>(detailKey);
  if (list)
    queryClient.setQueryData(listKey, patchCampaignInList(list, id, patch));
  if (detail) queryClient.setQueryData(detailKey, { ...detail, ...patch });
  return {
    rollback: () => {
      if (list) queryClient.setQueryData(listKey, list);
      if (detail) queryClient.setQueryData(detailKey, detail);
    },
  };
}

/** Re-read what a change can have touched; the list and detail always. */
function refreshCampaign(id: string, withStats = false) {
  const keys = [
    campaignKeys.list.queryKey,
    campaignKeys.detail(id).queryKey,
    ...(withStats ? [campaignKeys.stats(id).queryKey] : []),
  ];
  return Promise.all(
    keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
  );
}

/* -------------------------------- mutations ------------------------------- */

type MutationOptions<Data, Variables> = SolidMutationOptions<
  Data,
  Error,
  Variables,
  Rollback | undefined
>;

const launchOptions: MutationOptions<
  LaunchOutcome,
  { id: string; userConfirmation?: string }
> = {
  mutationFn: ({ id, userConfirmation }) =>
    throwOnErr(() => campaignsClient.launch(id, { userConfirmation })),
  onSuccess: async (_outcome, { id }) => {
    await patchCampaignCaches(id, {
      status: LAUNCHED_STATUS,
      launchedAt: new Date().toISOString(),
    });
    await Promise.all([
      refreshCampaign(id, true),
      queryClient.invalidateQueries({
        queryKey: campaignKeys.recipients(id).queryKey,
      }),
    ]);
  },
};

const pauseOptions: MutationOptions<void, { id: string }> = {
  mutationFn: ({ id }) => throwOnErr(() => campaignsClient.pause(id)),
  onMutate: ({ id }) => patchCampaignCaches(id, { status: PAUSED_STATUS }),
  onError: (_error, _vars, context) => context?.rollback(),
  onSettled: (_data, _error, { id }) => refreshCampaign(id, true),
};

const renameOptions: MutationOptions<void, { id: string; name: string }> = {
  mutationFn: ({ id, name }) =>
    throwOnErr(() => campaignsClient.rename(id, name)),
  onMutate: ({ id, name }) => patchCampaignCaches(id, { name }),
  onError: (_error, _vars, context) => context?.rollback(),
  onSettled: (_data, _error, { id }) => refreshCampaign(id),
};

const settingsOptions: MutationOptions<
  void,
  { id: string; settings: CampaignSettings }
> = {
  mutationFn: ({ id, settings }) =>
    throwOnErr(() => campaignsClient.updateSettings(id, settings)),
  onMutate: ({ id, settings }) => patchCampaignCaches(id, { settings }),
  onError: (_error, _vars, context) => context?.rollback(),
  onSettled: (_data, _error, { id }) => refreshCampaign(id),
};

const stepsOptions: MutationOptions<
  CampaignStep[],
  { id: string; steps: CampaignStepInput[] }
> = {
  mutationFn: ({ id, steps }) =>
    throwOnErr(() => campaignsClient.setSteps(id, steps)),
  onSuccess: (saved, { id }) => {
    queryClient.setQueryData(campaignKeys.steps(id).queryKey, saved);
  },
  // Step ids change with the sequence, so per-step counts must be re-read.
  onSettled: (_data, _error, { id }) =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: campaignKeys.steps(id).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: campaignKeys.stats(id).queryKey,
      }),
    ]),
};

const sendersOptions: MutationOptions<
  CampaignSender[],
  { id: string; senders: CampaignSender[] }
> = {
  mutationFn: ({ id, senders }) =>
    throwOnErr(() => campaignsClient.setSenders(id, senders)),
  onSuccess: (saved, { id }) => {
    queryClient.setQueryData(campaignKeys.senders(id).queryKey, saved);
  },
};

const trashOptions: MutationOptions<void, { id: string; trashed?: boolean }> = {
  mutationFn: ({ id, trashed = true }) =>
    throwOnErr(() => campaignsClient.trash(id, trashed)),
  onSuccess: async (_data, { id, trashed = true }) => {
    if (trashed) {
      queryClient.setQueryData<AccessibleCampaign[]>(
        campaignKeys.list.queryKey,
        (list) => removeCampaignFromList(list, id)
      );
      queryClient.removeQueries({ queryKey: campaignKeys.detail(id).queryKey });
    }
    // Trashing an active campaign pauses it; a restore returns it to the list.
    await queryClient.invalidateQueries({
      queryKey: campaignKeys.list.queryKey,
    });
  },
};

const createOptions: MutationOptions<AccessibleCampaign, CreateCampaign> = {
  mutationFn: (input) => throwOnErr(() => campaignsClient.create(input)),
  onSuccess: (created) => {
    queryClient.setQueryData(campaignKeys.detail(created.id).queryKey, created);
    queryClient.setQueryData<AccessibleCampaign[]>(
      campaignKeys.list.queryKey,
      (list) => (list ? [...list, created] : list)
    );
  },
  onSettled: () =>
    queryClient.invalidateQueries({ queryKey: campaignKeys.list.queryKey }),
};

const removeRecipientsOptions: MutationOptions<
  { removed: number },
  { id: string; rowIds: string[] }
> = {
  mutationFn: ({ id, rowIds }) =>
    throwOnErr(() => campaignsClient.removeRecipients(id, rowIds)),
  onSettled: (_data, _error, { id }) =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: campaignKeys.recipients(id).queryKey,
      }),
      queryClient.invalidateQueries({
        queryKey: campaignKeys.stats(id).queryKey,
      }),
    ]),
};

/** What would stop the campaign from sending; disabled while `id()` is undefined. */
export function useCampaignCheckQuery(id: Accessor<string | undefined>) {
  return useQuery(() => campaignCheckOptions(id()));
}

/** `mutate({ id, stepId?, rowId? })`. Sends [Test] copies to the caller only. */
export function useSendCampaignTest() {
  return useMutation(() => ({
    mutationFn: ({
      id,
      ...input
    }: {
      id: string;
      stepId?: string;
      rowId?: string;
    }) => throwOnErr(() => campaignsClient.sendTest(id, input)),
  }));
}

/** `mutate({ id, userConfirmation? })`. Enrolls contacts, then sets Active. */
export function useLaunchCampaign() {
  return useMutation(() => launchOptions);
}

/** `mutate({ id })`. The list and detail show Paused immediately. */
export function usePauseCampaign() {
  return useMutation(() => pauseOptions);
}

/** `mutate({ id, name })`. */
export function useRenameCampaign() {
  return useMutation(() => renameOptions);
}

/** `mutate({ id, settings })`, replacing every setting. */
export function useUpdateCampaignSettings() {
  return useMutation(() => settingsOptions);
}

/** `mutate({ id, steps })`, replacing the sequence; resolves to the saved steps. */
export function useSaveCampaignSteps() {
  return useMutation(() => stepsOptions);
}

/** `mutate({ id, senders })`, replacing the rotation. */
export function useSaveCampaignSenders() {
  return useMutation(() => sendersOptions);
}

/** `mutate({ id, trashed? })`; trashed defaults to true, false restores. */
export function useTrashCampaign() {
  return useMutation(() => trashOptions);
}

/** `mutate({ name, sharing? })`; resolves to the new draft. */
export function useCreateCampaign() {
  return useMutation(() => createOptions);
}

/** `mutate({ id, rowIds })`; stops those recipients' sequences. */
export function useRemoveCampaignRecipients() {
  return useMutation(() => removeRecipientsOptions);
}
