import { useCrmContactsQuery } from '@app/features/crm/queries/contact-suggestions';
import { toCrmContactEntity } from '@app/features/crm/queries/graphql';
import type { CombinedRecipientItem } from '@core/user/combinedRecipient';
import { queryClient } from '@queries/client';
import { queryReadyGate } from '@queries/gate';
import { type Accessor, createMemo } from 'solid-js';

/**
 * CRM contacts as recipient choices: the most recent ones, plus a server
 * search for whatever is typed, so anyone in the CRM can be found.
 */
export function useContactOptions(
  search: Accessor<string>,
  exclude: Accessor<Set<string>>
) {
  const recent = useCrmContactsQuery({ client: queryClient }, () => true);
  const found = useCrmContactsQuery(
    { client: queryClient },
    () => search().trim().length > 1,
    search,
    50
  );
  return createMemo(() => {
    const seen = new Set(exclude());
    const out: CombinedRecipientItem<'contact'>[] = [];
    for (const query of [found, recent]) {
      if (!queryReadyGate(query)) continue;
      for (const page of query.data.pages)
        for (const raw of page.contacts) {
          const contact = toCrmContactEntity(raw);
          const email = contact.email?.toLowerCase();
          if (!email || seen.has(email)) continue;
          seen.add(email);
          out.push({
            kind: 'contact',
            id: contact.id,
            data: {
              id: contact.id,
              type: 'extracted',
              email,
              name: contact.name === contact.email ? undefined : contact.name,
            },
          });
        }
    }
    return out;
  });
}
