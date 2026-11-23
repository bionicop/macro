import CheckCircleIcon from '@icon/system/regular/check-circle.svg';
import PaperPlaneTiltIcon from '@icon/system/regular/paper-plane-tilt.svg';
import WarningIcon from '@icon/system/regular/warning.svg';
import { ActionDialogShell, Button, Dialog } from '@ui';
import { createSignal, For, Match, Show, Switch } from 'solid-js';
import {
  useCampaignCheckQuery,
  useLaunchCampaign,
  useSendCampaignTest,
} from '../queries/campaigns';

export type LaunchDialogProps = {
  /** The draft being launched; the dialog is open while this is set. */
  campaignId: string | undefined;
  name: string;
  onClose: () => void;
  /** Where a problem is fixed: the sequence, people or settings tab. */
  onFix: (section: 'sequence' | 'people' | 'settings') => void;
};

const FIX_SECTION: Record<string, 'sequence' | 'people' | 'settings'> = {
  no_steps: 'sequence',
  empty_subject: 'sequence',
  empty_body: 'sequence',
  unknown_merge_field: 'sequence',
  no_recipients: 'people',
  no_senders: 'settings',
  sender_cap_zero: 'settings',
  window_empty: 'settings',
};

/**
 * The last stop before a first launch: what would stop the campaign from
 * sending, a test send to yourself, then Launch. A launch emails everyone on
 * the list, so it never happens on a single click.
 */
export function LaunchDialog(props: LaunchDialogProps) {
  const check = useCampaignCheckQuery(() => props.campaignId);
  const test = useSendCampaignTest();
  const launch = useLaunchCampaign();
  const [tested, setTested] = createSignal<string>();
  const ready = () => check.data?.ready === true;

  const close = () => {
    setTested(undefined);
    test.reset();
    props.onClose();
  };

  const sendTest = () => {
    const id = props.campaignId;
    if (!id) return;
    test.mutate(
      { id },
      {
        onSuccess: (result) => {
          const to = result.sent[0]?.to;
          setTested(
            result.sent.length === 0
              ? 'Nothing to send yet.'
              : `${result.sent.length} test ${result.sent.length === 1 ? 'email' : 'emails'} sent to ${to}. Check your inbox.`
          );
        },
      }
    );
  };

  const go = () => {
    const id = props.campaignId;
    if (!id || !ready()) return;
    launch.mutate({ id }, { onSuccess: close });
  };

  return (
    <Dialog
      open={props.campaignId !== undefined}
      onOpenChange={(open) => !open && !launch.isPending && close()}
      position="center"
      class="w-120"
      visibleScrim
    >
      <ActionDialogShell>
        <ActionDialogShell.Body>
          <ActionDialogShell.Header>
            <ActionDialogShell.Title>
              Launch {props.name}?
            </ActionDialogShell.Title>
            <ActionDialogShell.Description as="div">
              Everyone on the list starts the sequence. Send yourself a test
              first to see exactly what they get.
            </ActionDialogShell.Description>
          </ActionDialogShell.Header>
          <div class="mt-3 flex flex-col gap-2 text-sm">
            <Switch>
              <Match when={check.isPending}>
                <p class="text-ink-muted">Checking the campaign…</p>
              </Match>
              <Match when={check.isError}>
                <p class="flex items-center gap-2 text-failure">
                  <WarningIcon class="size-4 shrink-0" />
                  Couldn't check the campaign. Try again in a moment.
                </p>
              </Match>
              <Match when={ready()}>
                <p class="flex items-center gap-2 text-success">
                  <CheckCircleIcon class="size-4 shrink-0" />
                  Ready to send: copy, people, senders and schedule all check
                  out.
                </p>
              </Match>
              <Match when={check.data}>
                {(data) => (
                  <ul class="flex flex-col gap-1.5" aria-label="Before launch">
                    <For each={data().problems}>
                      {(problem) => (
                        <li class="flex items-start gap-2">
                          <WarningIcon class="mt-0.5 size-4 shrink-0 text-warning" />
                          <span class="min-w-0 flex-1 text-ink">
                            {problem.message}
                          </span>
                          <Show when={FIX_SECTION[problem.kind]}>
                            {(section) => (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  props.onFix(section());
                                  close();
                                }}
                              >
                                Fix
                              </Button>
                            )}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                )}
              </Match>
            </Switch>
            <Show when={tested()}>
              {(message) => (
                <p class="flex items-center gap-2 text-ink-muted" role="status">
                  <PaperPlaneTiltIcon class="size-4 shrink-0" />
                  {message()}
                </p>
              )}
            </Show>
            <Show when={test.isError}>
              <p class="text-failure" role="alert">
                The test didn't send. Check the sender in Settings.
              </p>
            </Show>
            <Show when={launch.isError}>
              <p class="text-failure" role="alert">
                Launch failed. Nothing was sent.
              </p>
            </Show>
          </div>
        </ActionDialogShell.Body>
        <ActionDialogShell.Footer>
          <Button
            type="button"
            variant="ghost"
            disabled={launch.isPending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={test.isPending || launch.isPending || !check.data}
            onClick={sendTest}
          >
            {test.isPending ? 'Sending…' : 'Send me a test'}
          </Button>
          <Button
            type="button"
            disabled={!ready() || launch.isPending}
            onClick={go}
          >
            {launch.isPending ? 'Launching…' : 'Launch'}
          </Button>
        </ActionDialogShell.Footer>
      </ActionDialogShell>
    </Dialog>
  );
}
