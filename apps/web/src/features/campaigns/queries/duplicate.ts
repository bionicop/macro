import { toast } from '@core/component/Toast/Toast';
import { throwOnErr } from '@core/util/result';
import { queryClient } from '@queries/client';
import { campaignsClient } from '@service-storage/campaigns';
import { campaignKeys } from './keys';
import { stepsToInputs } from './mapping';

/**
 * A draft copy of a campaign: its sequence, settings and senders. People are
 * not copied; a new campaign starts with no one enrolled.
 */
export function useDuplicateCampaign() {
  return async (id: string) => {
    try {
      const [source, steps, senders] = await Promise.all([
        throwOnErr(() => campaignsClient.get(id)),
        throwOnErr(() => campaignsClient.getSteps(id)),
        throwOnErr(() => campaignsClient.getSenders(id)),
      ]);
      const copy = await throwOnErr(() =>
        campaignsClient.create({
          name: `${source.name} (copy)`,
          sharing: source.sharing,
        })
      );
      await Promise.all([
        throwOnErr(() =>
          campaignsClient.setSteps(copy.id, stepsToInputs(steps))
        ),
        throwOnErr(() =>
          campaignsClient.updateSettings(copy.id, source.settings)
        ),
        throwOnErr(() => campaignsClient.setSenders(copy.id, senders)),
      ]);
    } catch {
      toast.failure('Couldn’t duplicate the campaign');
    } finally {
      await queryClient.invalidateQueries({
        queryKey: campaignKeys.list.queryKey,
      });
    }
  };
}
