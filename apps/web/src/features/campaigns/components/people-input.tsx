import { SettingsCard } from '@app/features/settings/primitives';
import { RecipientSelector } from '@core/component/RecipientSelector';
import { toast } from '@core/component/Toast/Toast';
import UploadIcon from '@icon/system/regular/upload-simple.svg';
import XIcon from '@icon/system/regular/x.svg';
import { Button, cn, Dialog } from '@ui';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { formatCount } from '../core/format';
import { MAX_PEOPLE, type Person, parsePeople } from '../core/people';
import { useAddCampaignPeople, useCampaignQuery } from '../queries';
import { useContactOptions } from '../queries/contacts';

const SHOWN = 200;

/**
 * Paste addresses or drop a CSV, see who will be added, remove anyone
 * before saving. Nothing is written here; the host saves the list.
 */
export function PeopleInput(props: {
  people: Person[];
  onChange: (people: Person[]) => void;
  /** People already in the campaign, shown above the new ones. */
  existing?: number;
  class?: string;
}) {
  const [text, setText] = createSignal('');
  const [note, setNote] = createSignal<string>();
  const [dragging, setDragging] = createSignal(false);
  const [search, setSearch] = createSignal('');
  // The picker clears its text only when its own selection changes, and its
  // selection stays empty here (picks go to the list), so a fresh one is
  // mounted after each pick.
  const [picks, setPicks] = createSignal(0);
  let fileInput: HTMLInputElement | undefined;
  const listed = createMemo(
    () => new Set(props.people.map((person) => person.email.toLowerCase()))
  );
  const contacts = useContactOptions(search, listed);

  const take = (input: string, source: string) => {
    const parsed = parsePeople(input, props.people);
    const room = MAX_PEOPLE - props.people.length;
    const added = parsed.people.slice(0, Math.max(0, room));
    props.onChange([...props.people, ...added]);
    setNote(
      [
        `${formatCount(added.length)} added from ${source}`,
        parsed.duplicates &&
          `${formatCount(parsed.duplicates)} already in the list`,
        parsed.skipped &&
          `${formatCount(parsed.skipped)} ${parsed.skipped === 1 ? 'line' : 'lines'} without an email`,
        parsed.people.length > added.length &&
          `limit is ${formatCount(MAX_PEOPLE)} at a time`,
      ]
        .filter(Boolean)
        .join(' · ')
    );
  };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10_000_000) {
      toast.failure('That file is over 10 MB. Split it and add each part.');
      return;
    }
    take(await file.text(), file.name);
  };

  const add = () => {
    take(text(), 'the paste');
    setText('');
  };

  return (
    <div class={cn('flex w-full flex-col gap-5', props.class)}>
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <Show when={picks() + 1} keyed>
            <RecipientSelector<'contact' | 'custom'>
              options={contacts}
              selectedOptions={[]}
              setSelectedOptions={(picked) => {
                const room = MAX_PEOPLE - props.people.length;
                const added = picked
                  .filter(
                    (item) =>
                      !(item.kind === 'custom' && item.data.invalid) &&
                      !listed().has(item.data.email.toLowerCase())
                  )
                  .slice(0, Math.max(0, room))
                  .map(
                    (item): Person =>
                      item.kind === 'contact' && item.data.name
                        ? { email: item.data.email, name: item.data.name }
                        : { email: item.data.email }
                  );
                if (!added.length) return;
                props.onChange([...props.people, ...added]);
                setSearch('');
                setPicks((n) => n + 1);
                setNote(
                  added.length === 1
                    ? `Added ${added[0].name || added[0].email}`
                    : `${formatCount(added.length)} added from your contacts`
                );
              }}
              onInputChange={setSearch}
              placeholder="Search your contacts, or type an address"
              focusOnMount={picks() > 0}
              showChipAddresses
              class="ph-no-capture"
            />
          </Show>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => fileInput?.click()}
        >
          <UploadIcon class="size-3.5" aria-hidden="true" />
          Upload CSV
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          class="hidden"
          onChange={(event) => {
            void readFile(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
        />
      </div>
      <div
        class={cn(
          'flex flex-col rounded-lg border border-edge-muted transition-colors focus-within:border-edge',
          dragging() && 'border-accent/60 bg-accent/5'
        )}
        onDragOver={(event) => {
          if (!event.dataTransfer?.types.includes('Files')) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void readFile(event.dataTransfer?.files[0]);
        }}
      >
        <textarea
          aria-label="Paste email addresses"
          rows={3}
          value={text()}
          placeholder={
            'Or paste addresses, one per line\njane@acme.com\nBob Smith <bob@globex.io>'
          }
          class="ph-no-capture min-h-20 w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-placeholder"
          onInput={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              (event.metaKey || event.ctrlKey) &&
              text().trim()
            ) {
              event.preventDefault();
              add();
            }
          }}
        />
        <div class="flex min-h-10 items-center gap-3 border-t border-edge-muted px-3 py-1.5">
          <span
            class="min-w-0 flex-1 truncate text-xs text-ink-muted"
            role="status"
          >
            {dragging()
              ? 'Drop to read the file'
              : (note() ??
                'CSV names come from a Name column, or First and Last name.')}
          </span>
          <Show when={text().trim()}>
            <Button type="button" size="sm" onClick={add}>
              Add to list
            </Button>
          </Show>
        </div>
      </div>

      <Show
        when={props.people.length}
        fallback={
          <Show when={props.existing}>
            <p class="text-xs text-ink-muted">
              {formatCount(props.existing ?? 0)} already in the campaign.
            </p>
          </Show>
        }
      >
        <section class="flex flex-col gap-2">
          <div class="flex items-center gap-3">
            <h3 class="text-sm font-medium text-ink">
              {formatCount(props.people.length)}{' '}
              {props.people.length === 1 ? 'person' : 'people'} to add
            </h3>
            <span class="min-w-0 flex-1 truncate text-xs text-ink-muted">
              {props.existing
                ? `${formatCount(props.existing)} already in the campaign`
                : 'Each becomes a CRM contact, or joins the existing one'}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                props.onChange([]);
                setNote(undefined);
              }}
            >
              Clear all
            </Button>
          </div>
          <SettingsCard class="max-h-80 overflow-y-auto">
            <For each={props.people.slice(0, SHOWN)}>
              {(person) => (
                <div class="group flex min-h-11 items-center gap-3 px-4 py-2">
                  <span class="ph-no-capture flex min-w-0 flex-1 items-baseline gap-2">
                    <span class="truncate text-sm">
                      {person.name || person.email}
                    </span>
                    <Show when={person.name}>
                      <span class="truncate text-sm text-ink-muted">
                        {person.email}
                      </span>
                    </Show>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${person.email}`}
                    tooltip="Remove"
                    class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() =>
                      props.onChange(props.people.filter((p) => p !== person))
                    }
                  >
                    <XIcon class="size-3.5" />
                  </Button>
                </div>
              )}
            </For>
            <Show when={props.people.length > SHOWN}>
              <div class="px-4 py-2 text-xs text-ink-muted">
                and {formatCount(props.people.length - SHOWN)} more
              </div>
            </Show>
          </SettingsCard>
        </section>
      </Show>
    </div>
  );
}

/** Add people to a saved campaign, from its People tab. */
export function AddPeopleDialog(props: {
  campaignId: string;
  open: boolean;
  existing?: number;
  onClose: () => void;
}) {
  const campaign = useCampaignQuery(() => props.campaignId);
  const add = useAddCampaignPeople();
  const [people, setPeople] = createSignal<Person[]>([]);
  const close = () => {
    if (add.isPending) return;
    setPeople([]);
    props.onClose();
  };
  const save = async () => {
    const table = campaign.data;
    if (!table || !people().length) return;
    try {
      const result = await add.mutateAsync({
        campaign: table,
        people: people(),
      });
      if (result.failed.length)
        toast.failure(
          `Added ${formatCount(result.added)}. ${formatCount(result.failed.length)} couldn’t be added: ${result.failed.slice(0, 3).join(', ')}${result.failed.length > 3 ? '…' : ''}`
        );
      else
        toast.success(
          `Added ${formatCount(result.added)} ${result.added === 1 ? 'person' : 'people'}`
        );
      setPeople([]);
      props.onClose();
    } catch {
      toast.failure('Couldn’t add them. Try again.');
    }
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && close()}
      position="center"
      animate
      class="w-[min(44rem,calc(100vw-32px))] max-w-none overflow-hidden"
    >
      <div class="flex max-h-[min(44rem,calc(100dvh-32px))] min-h-0 flex-col">
        <header class="flex shrink-0 flex-col gap-1 px-6 pt-6 pb-4">
          <Dialog.Title class="text-xl font-medium">Add people</Dialog.Title>
          <p class="text-sm text-ink-muted">
            {campaign.data?.status === 'draft'
              ? 'They start the sequence when you launch.'
              : 'They start the sequence at the next sending window.'}
          </p>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <PeopleInput
            people={people()}
            onChange={setPeople}
            existing={props.existing}
          />
        </div>
        <footer class="flex shrink-0 items-center justify-end gap-2 border-t border-edge-frame px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            disabled={add.isPending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="lg"
            disabled={!people().length || !campaign.data || add.isPending}
            onClick={() => void save()}
          >
            {add.isPending
              ? 'Adding…'
              : people().length
                ? `Add ${formatCount(people().length)} ${people().length === 1 ? 'person' : 'people'}`
                : 'Add people'}
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
