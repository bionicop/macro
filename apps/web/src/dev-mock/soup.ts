// LOCAL MOCK (not for commit). Sample user, team and Soup items for the dev gateway mock.
import crmSeed from '../../../../tooling/seed_cli/seed/crm.json';

const USER_ID = 'macro|dev@macro.local';
const TEAM_ID = 'team-dev';

export const user = {
  id: USER_ID,
  name: { id: USER_ID, first_name: 'Dev', last_name: 'User' },
  identity: {
    userId: USER_ID,
    email: 'dev@macro.local',
    name: 'Dev User',
    permissions: ['read:document', 'read:professional_features'],
    licenseStatus: 'Active',
    tutorialComplete: true,
    hasChromeExt: false,
    hasTrialed: true,
    isAgent: false,
    aiDataConsent: true,
    referralCode: 'DEV',
  },
};

export const team = {
  team: {
    id: TEAM_ID,
    name: 'Northwind Events',
    slug: 'northwind',
    owner_id: USER_ID,
    crm_enabled: true,
    enterprise: false,
    allow_non_admin_invites: true,
  },
  members: [{ team_id: TEAM_ID, user_id: USER_ID, role: 'owner', plan: 'max' }],
  scheduled_seat_plans: {},
};

const NIL = '00000000-0000-0000-0000-000000000000';
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-12T10:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const uuid = (kind: number, n: number) =>
  `00000000-0000-4000-8000-${String(kind).padStart(4, '0')}${String(n).padStart(8, '0')}`;

// Macro's own CRM seed (tooling/seed_cli/seed/crm.json), the data `seed-crm.ts`
// loads into a local stack; domains follow the `<key>.example` pattern.
const COMPANIES = crmSeed.companies.map(
  (c) => [c.name, `${c.key}.example`, `${c.stage} · ${c.notes}`] as const
);
const PEOPLE = crmSeed.companies.flatMap((c, ci) =>
  c.contacts.map((n) => [...(n.split(' ') as [string, string]), ci] as const)
);

export const companies = COMPANIES.map(([name, domain, description], i) => {
  const id = uuid(1, i + 1);
  return {
    id,
    teamId: TEAM_ID,
    name,
    description,
    emailSync: i % 3 !== 2,
    hidden: false,
    createdAt: ago(60 + i * 5),
    updatedAt: ago(i * 0.7),
    viewedAt: i < 4 ? ago(i + 0.2) : null,
    domains: [
      { id: uuid(2, i + 1), companyId: id, domain, createdAt: ago(60 + i * 5) },
    ],
    properties: [],
  };
});

export const contacts = PEOPLE.map(([first, last, c], i) => {
  const company = companies[c];
  const email = `${first.toLowerCase()}.${last.toLowerCase()}@${company.domains[0].domain}`;
  return {
    id: uuid(3, i + 1),
    teamId: TEAM_ID,
    name: `${first} ${last}`,
    email,
    companyId: company.id,
    companyName: company.name,
    personalEmail: false,
    hidden: false,
    firstInteraction: ago(50 - i),
    lastInteraction: ago(i * 0.6),
    createdAt: ago(50 - i),
    updatedAt: ago(i * 0.6),
    viewedAt: null,
    properties: [],
  };
});

const soupMeta = (i: number) => ({
  frecency_score: 100 - i,
  is_favorited: false,
});

/** True when a soup filter is the NIL literal the client uses to exclude a kind. */
const excluded = (filter: unknown) =>
  JSON.stringify(filter ?? null).includes(NIL);

/** REST `POST /dss/items/soup/ast` page. */
export function soupAstPage(body: Record<string, unknown>) {
  const items: unknown[] = [];
  if (body.ccf && !excluded(body.ccf))
    companies.forEach((data, i) => {
      items.push({ tag: 'crmCompany', data, ...soupMeta(i) });
    });
  if (body.crmf && !excluded(body.crmf))
    contacts.forEach((data, i) => {
      items.push({ tag: 'crmContact', data, ...soupMeta(i) });
    });
  return { items, next_cursor: null };
}

const seen: { operation: string; input: unknown }[] = [];
(globalThis as { __soup?: typeof seen }).__soup = seen;

/** GraphQL soup pages by operation; unknown operations return an empty page. */
export function soupResolver(input: unknown, operation: string) {
  seen.push({ operation, input });
  if (operation === 'CrmContacts')
    return {
      items: contacts.map((c) => ({
        __typename: 'GraphqlSoupCrmContact',
        ...c,
        parentCompanyId: c.companyId,
        parentCompanyName: c.companyName,
        emailAddress: c.email,
      })),
      nextCursor: null,
    };
  return { items: [], nextCursor: null };
}
