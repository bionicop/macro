import { $getCaretRect, isRectFlushWith } from '../../utils';
import { mergeRegister } from '@lexical/utils';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  type LexicalEditor,
} from 'lexical';
import type { HistoryCursor } from './historyCursor';

export type HistoryRecallOptions<T> = {
  cursor: HistoryCursor<T>;
  /** What the box holds right now: the draft to come back to. */
  current: () => T;
  /** Put an entry into the box (text, files, mentions) and move the caret to its end. */
  show: (entry: T) => void;
  /** Off for a read-only box, or while something else owns Up (a queued prompt). */
  enabled?: () => boolean;
};

/** Is the caret on the first (`top`) or last (`bottom`) visual line of the box? */
function caretAtEdge(lexical: LexicalEditor, side: 'top' | 'bottom'): boolean {
  return lexical.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
    const block = selection.anchor.getNode().getTopLevelElement();
    const root = $getRoot();
    if (!block) return false;
    const edgeBlock = side === 'top' ? root.getFirstChild() : root.getLastChild();
    if (block !== edgeBlock) return false;
    const box = lexical.getElementByKey(block.getKey())?.getBoundingClientRect();
    const caret = $getCaretRect();
    return !!box && !!caret && isRectFlushWith(caret, box, side, 5);
  });
}

/**
 * Up on the first line and Down on the last line walk the earlier messages,
 * like a terminal or a coding agent. Runs ahead of the keyboard-focus plugin
 * so recall wins over its leave-the-box handling; once the oldest entry is
 * reached Up falls through to it again.
 */
export function registerHistoryRecall<T>(
  lexical: LexicalEditor,
  options: HistoryRecallOptions<T>
): () => void {
  const { cursor, current, show, enabled = () => true } = options;
  const plain = (event: KeyboardEvent | null) =>
    !(event?.shiftKey || event?.altKey || event?.metaKey || event?.ctrlKey);

  const go = (
    event: KeyboardEvent | null,
    side: 'top' | 'bottom',
    step: () => T | undefined
  ) => {
    if (!enabled() || !plain(event) || !caretAtEdge(lexical, side)) return false;
    const entry = step();
    if (entry === undefined) return false;
    event?.preventDefault();
    show(entry);
    return true;
  };

  return mergeRegister(
    lexical.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event: KeyboardEvent | null) =>
        go(event, 'top', () => cursor.previous(current())),
      COMMAND_PRIORITY_CRITICAL
    ),
    lexical.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event: KeyboardEvent | null) =>
        cursor.browsing() && go(event, 'bottom', () => cursor.next()),
      COMMAND_PRIORITY_CRITICAL
    )
  );
}
