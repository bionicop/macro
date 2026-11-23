import type {
  AccessibleCampaign,
  CampaignSender,
} from '@service-storage/campaigns';
import { describe, expect, it } from 'vitest';
import { campaignsForInboxes } from './mailbox';

const campaign = (
  id: string,
  status: AccessibleCampaign['status'],
  name = id
) => ({ id, name, status, trashedAt: null }) as unknown as AccessibleCampaign;

const link = (link_id: string): CampaignSender => ({
  mailbox: { kind: 'link', link_id },
  dailyCap: 50,
});

const SENDERS: Record<string, CampaignSender[]> = {
  a: [link('inbox-1')],
  b: [link('inbox-2')],
  c: [link('inbox-1')],
  d: [link('inbox-1')],
  e: [{ mailbox: { kind: 'identity', identity_id: 'sg' }, dailyCap: 10 }],
};

const all = [
  campaign('c', 'paused', 'Charlie'),
  campaign('a', 'active', 'Alpha'),
  campaign('b', 'active', 'Bravo'),
  campaign('d', 'draft', 'Delta'),
  campaign('e', 'active', 'Echo'),
  campaign('f', 'active', 'Foxtrot'),
];

const ids = (list: AccessibleCampaign[]) => list.map((c) => c.id);

describe('campaignsForInboxes', () => {
  it('keeps sending campaigns on the chosen inbox, active first', () => {
    expect(
      ids(campaignsForInboxes(all, (id) => SENDERS[id], ['inbox-1']))
    ).toEqual(['a', 'c']);
  });

  it('lists every sending campaign with a sender when no inbox is chosen', () => {
    expect(
      ids(campaignsForInboxes(all, (id) => SENDERS[id], undefined))
    ).toEqual(['a', 'b', 'e', 'c']);
  });

  it('leaves out campaigns whose senders have not loaded', () => {
    expect(ids(campaignsForInboxes(all, () => undefined, undefined))).toEqual(
      []
    );
  });
});
