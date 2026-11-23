import { createQueryKeys } from '@lukemorales/query-key-factory';

export const campaignKeys = createQueryKeys('campaigns', {
  list: null,
  detail: (id: string) => [id],
  steps: (id: string) => [id],
  senders: (id: string) => [id],
  check: (id: string) => [id],
  stats: (id: string) => [id],
  dailyStats: (id: string, from: string, to: string, tz: string) => [
    id,
    from,
    to,
    tz,
  ],
  allDailyStats: (from: string, to: string, tz: string) => [from, to, tz],
  recipients: (id: string) => [id],
  rowCount: (id: string) => [id],
  events: (id: string) => [id],
  replyDrafts: (id: string) => [id],
  identities: null,
  sendgrid: null,
});
