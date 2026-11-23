import { throwOnErr } from '@core/util/result';
import {
  type CampaignDailyRange,
  campaignsClient,
} from '@service-storage/campaigns';
import { queryOptions, useQueries } from '@tanstack/solid-query';
import type { Accessor } from 'solid-js';
import { campaignKeys } from './keys';

/**
 * Totals for every campaign in a list, one stats request each. The list
 * endpoint carries no counts, so the table reads them from here.
 */
export function useCampaignsStatsQueries(ids: Accessor<readonly string[]>) {
  return useQueries(() => ({
    queries: [...new Set(ids())].map((id) =>
      queryOptions({
        queryKey: campaignKeys.stats(id).queryKey,
        queryFn: () => throwOnErr(() => campaignsClient.getStats(id)),
        // Counts move while a campaign sends.
        staleTime: 30_000,
      })
    ),
  }));
}

/**
 * Each campaign's day-by-day counts over one range, in the order of `ids`,
 * so the totals can follow whichever campaigns the list is showing.
 */
export function useCampaignsDailyQueries(
  ids: Accessor<readonly string[]>,
  range: Accessor<CampaignDailyRange>
) {
  return useQueries(() => {
    const { from, to, tz } = range();
    return {
      queries: ids().map((id) =>
        queryOptions({
          queryKey: campaignKeys.dailyStats(id, from, to, tz).queryKey,
          queryFn: () =>
            throwOnErr(() =>
              campaignsClient.getDailyStats(id, { from, to, tz })
            ),
          staleTime: 60_000,
        })
      ),
    };
  });
}
