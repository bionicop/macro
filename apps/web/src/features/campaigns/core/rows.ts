// The campaign API's shapes, mapped into what the campaign views draw.

import type {
  AccessibleCampaign,
  CampaignStats,
  CampaignStep,
  CampaignStepInput,
} from '@service-storage/campaigns';
import {
  delayDaysToMinutes,
  delayMinutesToDays,
  minutesToClock,
} from '../queries/mapping';
import type { SequenceNode } from '../views/campaign-sequence';
import type { Campaign } from './sample';

/** One table row: the campaign with its totals; zeros until stats load. */
export function toCampaignRow(
  campaign: AccessibleCampaign,
  stats: CampaignStats | undefined
): Campaign {
  const { windowStartMinute, windowEndMinute } = campaign.settings;
  return {
    id: campaign.id,
    name: campaign.name,
    audience: '',
    status: campaign.status,
    people: stats?.enrolled ?? 0,
    sent: stats?.sent ?? 0,
    replied: stats?.replied ?? 0,
    // Meetings are not tracked by the campaign service.
    meetings: 0,
    bounced: stats?.bounced ?? 0,
    opened: stats?.opened ?? 0,
    daily: [],
    steps: [],
    window: `${minutesToClock(windowStartMinute)}–${minutesToClock(windowEndMinute)}`,
    ownerId: campaign.userId,
    sharing: campaign.sharing,
    createdAt: campaign.createdAt,
    launchedAt: campaign.launchedAt,
  };
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ] ?? char
  );

/** Plain text as paragraphs, one per blank-line-separated block. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .filter((block) => block.trim())
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** The visible text of stored HTML, for editing as plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** Saved steps, in order, with each step's send and reply counts. */
export function stepsToNodes(
  steps: readonly CampaignStep[],
  stats: CampaignStats | undefined
): SequenceNode[] {
  const byStep = new Map(stats?.steps.map((step) => [step.stepId, step]));
  return [...steps]
    .sort((a, b) => a.position - b.position)
    .map((step, index) => ({
      id: step.id,
      delayDays: index === 0 ? 0 : delayMinutesToDays(step.delayMinutes),
      subject: step.subject,
      body: step.bodyText ?? htmlToText(step.bodyHtml),
      condition: index === 0 ? 'always' : (step.condition ?? 'always'),
      sent: byStep.get(step.id)?.sent ?? 0,
      opened: byStep.get(step.id)?.opened ?? 0,
      replied: byStep.get(step.id)?.replied ?? 0,
      saved: true,
    }));
}

/** The canvas back into the steps API; unsaved nodes go without an id. */
export function nodesToInputs(
  nodes: readonly SequenceNode[]
): CampaignStepInput[] {
  return nodes.map((node, index) => ({
    id: node.saved ? node.id : null,
    delayMinutes: index === 0 ? 0 : delayDaysToMinutes(node.delayDays),
    subject: node.subject,
    bodyHtml: textToHtml(node.body),
    bodyText: node.body,
    condition: index === 0 ? 'always' : node.condition,
  }));
}
