import type { ItemMention } from '@core/component/LexicalMarkdown/plugins';
import { Telemetry } from '@macro-inc/observability';
import { makePersisted } from '@solid-primitives/storage';
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  on,
} from 'solid-js';
import type {
  InputAttachmentTracker,
  InputCallbacks,
  InputData,
  InputPersistenceKey,
  InputSnapshot,
} from './types';

type CreateInputViewOptions = {
  initialInput: InputData;
  mentions: Accessor<ItemMention[]>;
  attachmentTracker: InputAttachmentTracker;
  callbacks?: InputCallbacks;
  persistenceKey?: InputPersistenceKey;
};

export type InputView = {
  view: Accessor<InputData>;
  snapshot: Accessor<InputSnapshot>;
  value: Accessor<string>;
  showFormatRibbon: Accessor<boolean>;
  isSending: Accessor<boolean>;
  setValue: (value: string) => void;
  /** While on, `setValue` is held in memory only (recalled history). */
  setPreviewing: (on: boolean) => void;
  setShowFormatRibbon: (updater: (prev: boolean) => boolean) => void;
  setIsSending: (value: boolean) => void;
  setIsDraggedOver: (value: boolean) => void;
  reset: () => void;
};

export function createInputView(options: CreateInputViewOptions): InputView {
  const rawValue = createSignal<string | undefined>(
    options.initialInput.value || undefined
  );
  const [persistedValue, setValueSignal] = options.persistenceKey
    ? makePersisted(rawValue, { name: options.persistenceKey })
    : rawValue;
  // Text brought back by Up/Down recall is shown but never saved as the draft,
  // so a reload shows what the user was really writing.
  const [preview, setPreview] = createSignal<string>();
  let previewing = false;
  const value = () => preview() ?? persistedValue() ?? '';

  const [showFormatRibbon, setShowFormatRibbon] = createSignal(
    !!options.initialInput.showFormatRibbon
  );
  const [isSending, setIsSending] = createSignal(false);
  const [isDraggedOver, setIsDraggedOver] = createSignal(false);

  const snapshot = createMemo<InputSnapshot>(() => ({
    value: value(),
    mentions: options.mentions(),
    attachments: options.attachmentTracker.attachments(),
  }));

  const view = createMemo<InputData>(() => ({
    ...options.initialInput,
    value: value(),
    isDraggedOver: isDraggedOver() || options.initialInput.isDraggedOver,
    showFormatRibbon: showFormatRibbon(),
    hasPendingAttachments:
      isSending() || options.attachmentTracker.hasPending(),
    attachments: options.attachmentTracker.attachments(),
  }));

  createEffect(
    on(
      snapshot,
      (current) => {
        Promise.resolve(options.callbacks?.onChange?.(current)).catch((error) =>
          Telemetry.error(error, { surface: 'channel-input' })
        );
      },
      { defer: true }
    )
  );

  const setValue = (nextValue: string) => {
    if (previewing) {
      setPreview(nextValue);
      return;
    }
    setPreview(undefined);
    setValueSignal(nextValue || undefined);
  };

  const setPreviewing = (on: boolean) => {
    previewing = on;
    if (!on) setPreview(undefined);
  };

  const reset = () => {
    setPreviewing(false);
    setValue('');
    options.attachmentTracker.clearAttachments();
  };

  return {
    view,
    snapshot,
    value,
    showFormatRibbon,
    isSending,
    setValue,
    setPreviewing,
    setShowFormatRibbon,
    setIsSending,
    setIsDraggedOver,
    reset,
  };
}
