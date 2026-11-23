/**
 * Up/Down recall of earlier prompts in an agent session.
 *
 * The prompts are the session's own sent messages, so there is no second list
 * to keep in sync and a reload or restart brings them back with the
 * transcript. An entry is what the box held when it was sent: the text (quote
 * chips and mentions live inside it) and the files that went with it.
 */

import type { InputAttachmentData } from '@channel/Input';
import type { MessagePart } from '@service-agent-fold/generated/types';
import {
  attachmentMedium,
  staticFileIdFromUri,
} from '../component/parts/AttachmentPart';

export type PromptEntry = {
  value: string;
  attachments: InputAttachmentData[];
};

type AttachmentPart = Extract<MessagePart, { kind: 'attachment' }>;

/** The harness prepends a `<m-agent-context>` block to every prompt; it is not the user's text. */
function withoutAgentContext(text: string): string {
  const close = '</m-agent-context>';
  if (!text.startsWith('<m-agent-context>')) return text;
  const end = text.indexOf(close);
  return end < 0 ? text : text.slice(end + close.length);
}

/** The composer chip for a file that was sent with a prompt. */
function chipOf(part: AttachmentPart): InputAttachmentData {
  const medium = attachmentMedium(part);
  return {
    id: staticFileIdFromUri(part.uri),
    name: part.name,
    kind: medium === 'file' ? 'document' : medium,
    ...(part.mimeType ? { mimeType: part.mimeType } : {}),
    ...(part.size !== null ? { size: part.size } : {}),
  };
}

type PromptMessage = {
  author: { kind: string };
  parts: ReadonlyArray<{ kind: string }>;
};

/** Each prompt a user sent into the session, oldest first. */
export function sentPrompts(
  messages: ReadonlyArray<PromptMessage>
): PromptEntry[] {
  const prompts: PromptEntry[] = [];
  for (const message of messages) {
    if (message.author.kind !== 'user') continue;
    const parts = message.parts as ReadonlyArray<
      { kind: 'text'; text: string } | AttachmentPart | { kind: string }
    >;
    const value = parts
      .flatMap((part) =>
        part.kind === 'text' && 'text' in part
          ? [withoutAgentContext(part.text)]
          : []
      )
      .join('\n')
      .trim();
    const attachments = parts.flatMap((part) =>
      part.kind === 'attachment' ? [chipOf(part as AttachmentPart)] : []
    );
    if (!value && attachments.length === 0) continue;
    const last = prompts[prompts.length - 1];
    if (
      last &&
      last.value === value &&
      last.attachments.map((a) => a.id).join() ===
        attachments.map((a) => a.id).join()
    )
      continue;
    prompts.push({ value, attachments });
  }
  return prompts;
}
