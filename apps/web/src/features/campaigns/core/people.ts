// People added to a campaign: parsed from pasted text or a CSV, matched to
// CRM contacts, then written as rows of the campaign's people table.

import type { DatabaseOp } from '@core/database-sql/generated/types';
import { ThrownResultError, throwOnErr } from '@core/util/result';
import { campaignsClient } from '@service-storage/campaigns';
import { storageServiceClient } from '@service-storage/client';
import { fetchCrmContacts } from '@service-storage/crm-contacts';
import Papa from 'papaparse';

export type Person = { email: string; name?: string };

/** What a paste or file turned into. */
export type ParsedPeople = {
  people: Person[];
  /** Lines with no email address in them. */
  skipped: number;
  /** Addresses given more than once, or already in the list. */
  duplicates: number;
};

/** The parts of a campaign the people table is written through. */
export type PeopleTable = {
  id: string;
  tableId: string;
  primaryColumnId: string;
};

export const MAX_PEOPLE = 10_000;
const EMAIL = /[^\s@<>,;"'()]+@[^\s@<>,;"'()]+\.[^\s@<>,;"'()]+/g;
const NAME_HEADERS = ['name', 'full name', 'first name', 'contact'];
const CONTACT_CREATE_CONCURRENCY = 4;
const INSERT_BATCH = 500;

const clean = (text: string) =>
  text
    .replace(/[<>"'()]/g, ' ')
    .replace(/[,;\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Reads emails from anything a person might paste: one per line, a list
 * separated by commas, `Jane Doe <jane@acme.com>`, or a CSV with a header
 * row that names an email column (and optionally a name column).
 */
export function parsePeople(
  text: string,
  existing: readonly Person[] = []
): ParsedPeople {
  const seen = new Set(existing.map((person) => person.email.toLowerCase()));
  const people: Person[] = [];
  let skipped = 0;
  let duplicates = 0;
  const add = (email: string, name?: string) => {
    const key = email.toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      return;
    }
    seen.add(key);
    people.push(name ? { email, name } : { email });
  };

  const rows = Papa.parse<string[]>(text.trim(), {
    skipEmptyLines: 'greedy',
  }).data;
  const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) ?? [];
  const emailColumn = header.findIndex((cell) =>
    ['email', 'e-mail', 'email address', 'mail'].includes(cell)
  );

  if (emailColumn >= 0) {
    const nameColumn = header.findIndex((cell) => NAME_HEADERS.includes(cell));
    const lastColumn = header.indexOf('last name');
    for (const row of rows.slice(1)) {
      const email = row[emailColumn]?.trim().match(EMAIL)?.[0];
      if (!email) {
        skipped += 1;
        continue;
      }
      const name = [row[nameColumn], lastColumn >= 0 ? row[lastColumn] : '']
        .map((part) => part?.trim())
        .filter(Boolean)
        .join(' ');
      add(email, nameColumn >= 0 && name ? name : undefined);
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const emails = line.match(EMAIL) ?? [];
      if (!emails.length) {
        skipped += 1;
        continue;
      }
      // A single address may come with a name; a list of them never does.
      const name =
        emails.length === 1 ? clean(line.replace(emails[0]!, '')) : '';
      for (const email of emails) add(email, name || undefined);
    }
  }
  return { people: people.slice(0, MAX_PEOPLE), skipped, duplicates };
}

/** "jane.doe@acme.com" becomes "Jane Doe" when no name was given. */
export function nameFromEmail(email: string): string {
  return (email.split('@')[0] ?? email)
    .split(/[._+-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

const isConflict = (error: unknown) =>
  error instanceof ThrownResultError &&
  error.errors.some((e) => e.code === 'CONFLICT');

/** The CRM contact for an email: created, or the one that already has it. */
async function contactFor(person: Person): Promise<string | undefined> {
  try {
    const contact = await throwOnErr(() =>
      storageServiceClient.createTeamContact({
        name: person.name || nameFromEmail(person.email),
        email: person.email,
      })
    );
    return contact.id;
  } catch (error) {
    if (!isConflict(error)) return undefined;
    const { contacts } = await fetchCrmContacts({
      search: person.email,
      limit: 10,
    });
    return contacts.find(
      (contact) =>
        contact.contactEmail?.toLowerCase() === person.email.toLowerCase()
    )?.id;
  }
}

/**
 * Adds people to the campaign's table, one row per CRM contact. Rows are
 * enrolled when the campaign launches (or at once, if it is running).
 */
export async function addCampaignPeople(
  campaign: PeopleTable,
  people: readonly Person[]
): Promise<{ added: number; failed: string[] }> {
  const ids: string[] = [];
  const failed: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < people.length) {
      const person = people[next++]!;
      const id = await contactFor(person).catch(() => undefined);
      if (id) ids.push(id);
      else failed.push(person.email);
    }
  };
  await Promise.all(Array.from({ length: CONTACT_CREATE_CONCURRENCY }, worker));

  for (let at = 0; at < ids.length; at += INSERT_BATCH) {
    const op: DatabaseOp = {
      kind: 'rows',
      table: campaign.tableId,
      change: {
        kind: 'insert',
        rows: ids.slice(at, at + INSERT_BATCH).map((entityId) => [
          {
            column: campaign.primaryColumnId,
            value: {
              type: 'entities',
              value: [{ entityType: 'CONTACT', entityId }],
            },
          },
        ]),
      },
    } as DatabaseOp;
    await throwOnErr(() => campaignsClient.applyOps(campaign.id, [op]));
  }
  return { added: ids.length, failed };
}
