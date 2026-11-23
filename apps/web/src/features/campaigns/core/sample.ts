// Sample campaigns for local development, used until the campaigns API is
// wired in. Addresses are example.com; names are generic.

/** The backend's campaign states (`crates/campaign` CampaignStatus). */
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';

export type CampaignStep = {
  id: string;
  /** Days after the person joins the campaign. */
  day: number;
  subject: string;
  /** When the step goes out, in plain words. */
  note: string;
  sent: number;
  replied: number;
};

export type Campaign = {
  id: string;
  name: string;
  /** Who the campaign is for, shown as a muted tag. */
  audience: string;
  status: CampaignStatus;
  people: number;
  sent: number;
  replied: number;
  meetings: number;
  /** Opens; counted only when the campaign tracks them. */
  opened?: number;
  bounced: number;
  /** Sends per day for the last 14 days, oldest first. */
  daily: number[];
  steps: CampaignStep[];
  /** Local send window, e.g. 09:00–17:00. */
  window: string;
  ownerId?: string;
  sharing?: 'private' | 'team';
  createdAt?: string;
  launchedAt?: string | null;
};

export type RangeDays = 7 | 30 | 90;

const STEP_DAYS = [0, 3, 8, 14, 21];

/** Steps with a natural drop-off: each later step reaches fewer people. */
const steps = (base: number, subjects: string[]): CampaignStep[] =>
  subjects.map((subject, index) => ({
    id: `s${index + 1}`,
    day: STEP_DAYS[index] ?? index * 7,
    subject,
    note:
      index === 0
        ? 'First email'
        : index === 1
          ? 'Same thread · only if there’s no reply'
          : 'Only if there’s no reply',
    sent: Math.round(base * 0.8 ** index),
    replied: Math.round(base * 0.8 ** index * (0.06 - index * 0.01)),
  }));

export const SAMPLE_CAMPAIGNS: Campaign[] = [
  {
    id: 'c1',
    name: 'Expo exhibitor invites',
    audience: 'Event organisers',
    status: 'active',
    people: 1420,
    sent: 1186,
    replied: 94,
    meetings: 21,
    bounced: 17,
    daily: [42, 55, 61, 0, 0, 72, 80, 84, 78, 0, 0, 90, 96, 88],
    steps: steps(620, [
      'A stand for {{company}} at {{event_name}}?',
      'Quick follow-up on {{event_name}}',
      'Last call for exhibitor slots',
    ]),
    window: '09:00–17:00',
  },
  {
    id: 'c2',
    name: 'Webinar follow-ups',
    audience: 'Attendees',
    status: 'draft',
    people: 380,
    sent: 212,
    replied: 31,
    meetings: 9,
    bounced: 3,
    daily: [0, 12, 18, 20, 0, 0, 22, 25, 19, 0, 0, 14, 0, 0],
    steps: steps(140, [
      'Thanks for joining, {{first_name}}',
      'The slides you asked for',
      'One question about your setup',
    ]),
    window: '10:00–16:00',
  },
  {
    id: 'c3',
    name: 'Quarterly re-engagement',
    audience: 'Past customers',
    status: 'paused',
    people: 960,
    sent: 540,
    replied: 22,
    meetings: 4,
    bounced: 31,
    daily: [30, 36, 41, 0, 0, 39, 44, 12, 0, 0, 0, 0, 0, 0],
    steps: steps(300, [
      'Still using {{product}}, {{first_name}}?',
      'What changed since we last spoke',
      'Should I close your file?',
    ]),
    window: '09:00–17:00',
  },
  {
    id: 'c4',
    name: 'Partner introductions',
    audience: 'Agencies',
    status: 'draft',
    people: 0,
    sent: 0,
    replied: 0,
    meetings: 0,
    bounced: 0,
    daily: Array(14).fill(0),
    steps: steps(0, [
      'An introduction from {{referrer}}',
      'Following up on the introduction',
      'Closing the loop',
    ]),
    window: '09:00–17:00',
  },
  {
    id: 'c5',
    name: 'Launch announcement',
    audience: 'Newsletter',
    status: 'completed',
    people: 2100,
    sent: 2084,
    replied: 61,
    meetings: 12,
    bounced: 26,
    daily: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    steps: steps(2084, [
      'Something new from us',
      'In case you missed it',
      'Last note on the launch',
    ]),
    window: '08:00–12:00',
  },
  {
    id: 'c6',
    name: 'Trade show leads — Hall B, spring',
    audience: 'Booth visitors',
    status: 'active',
    people: 640,
    sent: 418,
    replied: 37,
    meetings: 11,
    bounced: 6,
    daily: [0, 0, 18, 24, 31, 0, 0, 36, 40, 38, 42, 0, 0, 44],
    steps: steps(260, [
      'Good to meet you at the show, {{first_name}}',
      'The pricing sheet from the booth',
      'Worth a 15-minute call?',
      'Closing the loop',
    ]),
    window: '09:00–17:00',
  },
  {
    id: 'c7',
    name: 'Free trial nudges',
    audience: 'Trial users',
    status: 'active',
    people: 1180,
    sent: 902,
    replied: 58,
    meetings: 14,
    bounced: 9,
    daily: [61, 58, 0, 0, 64, 70, 66, 59, 63, 0, 0, 71, 68, 52],
    steps: steps(480, [
      'Getting started with {{product}}',
      'Three things most teams set up first',
    ]),
    window: '08:00–18:00',
  },
  {
    id: 'c8',
    name: 'Analyst briefing requests',
    audience: 'Industry analysts',
    status: 'draft',
    people: 74,
    sent: 0,
    replied: 0,
    meetings: 0,
    bounced: 0,
    daily: Array(14).fill(0),
    steps: steps(0, [
      'A briefing on {{topic}}?',
      'Following up on the briefing',
      'Last note from me',
    ]),
    window: '10:00–15:00',
  },
  {
    id: 'c9',
    name: 'Renewal reminders',
    audience: 'Customers',
    status: 'active',
    people: 310,
    sent: 296,
    replied: 41,
    meetings: 3,
    bounced: 1,
    daily: [8, 11, 0, 0, 14, 12, 9, 13, 10, 0, 0, 12, 15, 11],
    steps: steps(180, [
      'Your plan renews on {{renewal_date}}',
      'Anything to change before renewal?',
    ]),
    window: '09:00–17:00',
  },
  {
    id: 'c10',
    name: 'Speaker outreach',
    audience: 'Speakers',
    status: 'paused',
    people: 120,
    sent: 88,
    replied: 19,
    meetings: 7,
    bounced: 5,
    daily: [6, 9, 7, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0],
    steps: steps(70, [
      'Would you speak at {{event_name}}?',
      'The agenda so far',
      'Slots are filling up',
      'Last call for speakers',
      'Thanks either way',
    ]),
    window: '09:00–17:00',
  },
  {
    id: 'c11',
    name: 'Sponsor prospecting',
    audience: 'Sponsors',
    status: 'draft',
    people: 215,
    sent: 0,
    replied: 0,
    meetings: 0,
    bounced: 0,
    daily: Array(14).fill(0),
    steps: steps(0, [
      'Sponsoring {{event_name}} this year',
      'The sponsor pack',
      'A quick yes or no?',
    ]),
    window: '09:00–17:00',
  },
  {
    id: 'c12',
    name: 'Holiday greetings',
    audience: 'Customers',
    status: 'completed',
    people: 860,
    sent: 852,
    replied: 24,
    meetings: 1,
    bounced: 8,
    daily: Array(14).fill(0),
    steps: steps(852, ['Happy holidays from all of us']),
    window: '08:00–12:00',
  },
];

/** Where a person is in a campaign, in the words outreach tools use. */
export type LeadStatus =
  | 'not_contacted'
  | 'contacted'
  | 'replied'
  | 'interested'
  | 'meeting_booked'
  | 'out_of_office'
  | 'not_interested'
  | 'bounced'
  | 'unsubscribed'
  | 'completed';

export type CampaignLead = {
  id: string;
  name: string;
  email: string;
  company: string;
  status: LeadStatus;
  /** The last step this person was sent, 0 before the first email. */
  step: number;
  /** Days since anything happened with this person. */
  lastActivityDays: number;
};

export type CampaignDetails = {
  owner: string;
  createdDaysAgo: number;
  days: string;
  timezone: string;
  dailyLimit: number;
  inboxes: string[];
  stopOnReply: 'person' | 'company';
  trackOpens: boolean;
  plainText: boolean;
};

const INBOXES = [
  'events@northwind.example',
  'hello@northwind.example',
  'team@northwind-events.example',
];

/** Settings each campaign carries; the sample keeps them uniform. */
export function campaignDetails(campaign: Campaign): CampaignDetails {
  const index = SAMPLE_CAMPAIGNS.indexOf(campaign);
  return {
    owner: 'Dev User',
    createdDaysAgo: 6 + index * 9,
    days: 'Mon–Fri',
    timezone: 'Each person’s time zone',
    dailyLimit: campaign.people > 1000 ? 120 : 60,
    inboxes: INBOXES.slice(0, 1 + (index % 3)),
    stopOnReply: 'company',
    trackOpens: false,
    plainText: true,
  };
}

const FIRST = [
  'Maya',
  'Leo',
  'Priya',
  'Jonas',
  'Amara',
  'Tom',
  'Sofia',
  'Ravi',
  'Elena',
  'Kofi',
  'Hana',
  'Marc',
  'Ines',
  'Sam',
  'Yuki',
  'Noah',
];
const LAST = [
  'Chen',
  'Park',
  'Nair',
  'Weber',
  'Okafor',
  'Reid',
  'Costa',
  'Shah',
  'Novak',
  'Mensah',
  'Sato',
  'Dubois',
  'Lopez',
  'Hart',
  'Ito',
  'Berg',
];
const COMPANIES = [
  'Atlas Labs',
  'Cedar Health',
  'Northstar Analytics',
  'Orbit Design',
  'Summit Logistics',
  'Harbor Finance',
  'Juniper Commerce',
  'Maple Robotics',
];

/** A sample of the people in a campaign, spread across statuses by its results. */
export function sampleLeads(campaign: Campaign): CampaignLead[] {
  const total = Math.min(campaign.people, 48);
  const sentShare = campaign.people ? campaign.sent / campaign.people : 0;
  const steps = campaign.steps.length;
  return Array.from({ length: total }, (_, i) => {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[(i * 7) % LAST.length]!;
    const company = COMPANIES[(i * 3) % COMPANIES.length]!;
    const domain = `${company.toLowerCase().split(' ')[0]}.example`;
    // A fixed spread so each campaign reads plausibly against its totals.
    const roll = ((i * 37) % 100) / 100;
    let status: LeadStatus = 'not_contacted';
    if (roll < sentShare) {
      const r = (i * 13) % 20;
      status =
        r === 0
          ? 'meeting_booked'
          : r === 1
            ? 'interested'
            : r === 2
              ? 'replied'
              : r === 3
                ? 'out_of_office'
                : r === 4
                  ? 'not_interested'
                  : r === 5 && campaign.bounced > 0
                    ? 'bounced'
                    : r === 6
                      ? 'unsubscribed'
                      : campaign.status === 'completed'
                        ? 'completed'
                        : 'contacted';
    }
    return {
      id: `${campaign.id}-p${i + 1}`,
      name: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`,
      company,
      status,
      step: status === 'not_contacted' ? 0 : 1 + (i % Math.max(1, steps)),
      lastActivityDays: status === 'not_contacted' ? -1 : (i * 5) % 13,
    };
  });
}

/** Scale lifetime figures to the chosen range so the stat row reacts to it. */
export function rangeShare(range: RangeDays) {
  return range === 7 ? 0.32 : range === 30 ? 0.78 : 1;
}
