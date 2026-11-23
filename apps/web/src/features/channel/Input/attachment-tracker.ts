import { makePersisted } from '@solid-primitives/storage';
import { type Accessor, createMemo, createSignal } from 'solid-js';
import type { InputAttachmentData } from './types';

export type InputAttachmentTracker = {
  attachments: Accessor<InputAttachmentData[]>;
  hasPending: Accessor<boolean>;
  addAttachment: (attachment: InputAttachmentData) => void;
  removeAttachment: (attachmentId: string) => void;
  setAttachmentPending: (attachmentId: string, pending: boolean) => void;
  setAttachments: (attachments: InputAttachmentData[]) => void;
  /** Show files in the composer without saving them as the draft (recalled history). `undefined` ends the preview. */
  previewAttachments: (attachments: InputAttachmentData[] | undefined) => void;
  clearAttachments: () => void;
};

type CreateInputAttachmentTrackerOptions = {
  persistenceKey?: string;
  initialAttachments?: InputAttachmentData[];
  maxAttachments?: number;
};

export function createInputAttachmentTracker(
  options: CreateInputAttachmentTrackerOptions = {}
): InputAttachmentTracker {
  const raw = createSignal<InputAttachmentData[]>(
    options.initialAttachments ?? []
  );

  const [stored, setStored] = options.persistenceKey
    ? makePersisted(raw, {
        name: options.persistenceKey,
        serialize: (data: InputAttachmentData[]) =>
          JSON.stringify(data.filter((a) => !a.pending)),
        deserialize: (data: string) =>
          (JSON.parse(data) as InputAttachmentData[]).filter((a) => !a.pending),
      })
    : raw;

  const [preview, setPreview] = createSignal<InputAttachmentData[]>();
  const attachments = () => preview() ?? stored();
  // Editing recalled files makes them the draft.
  const setAttachments: typeof setStored = (next) => {
    const shown = preview();
    setPreview(undefined);
    if (shown) setStored(shown);
    return setStored(next);
  };

  const maxAttachments = options.maxAttachments ?? 10;

  const hasPending = createMemo(() =>
    attachments().some((attachment) => attachment.pending === true)
  );

  const addAttachment = (attachment: InputAttachmentData) => {
    setAttachments((current) => {
      if (current.some((item) => item.id === attachment.id)) return current;
      if (current.length >= maxAttachments) return current;
      return [...current, attachment];
    });
  };

  const removeAttachment = (attachmentId: string) => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId)
    );
  };

  const setAttachmentPending = (attachmentId: string, pending: boolean) => {
    setAttachments((current) =>
      current.map((attachment) =>
        attachment.id === attachmentId ? { ...attachment, pending } : attachment
      )
    );
  };

  const replaceAttachments = (nextAttachments: InputAttachmentData[]) => {
    setPreview(undefined);
    setStored(nextAttachments);
  };

  const clearAttachments = () => {
    setAttachments([]);
  };

  return {
    attachments,
    hasPending,
    addAttachment,
    removeAttachment,
    setAttachmentPending,
    setAttachments: replaceAttachments,
    previewAttachments: setPreview,
    clearAttachments,
  };
}
