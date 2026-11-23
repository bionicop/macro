/**
 * A cursor over earlier messages, for Up/Down recall in a message box.
 *
 * Generic over what an entry is (text, or text plus files and mentions), so
 * every message box shares one set of rules. The entries come from the
 * persisted conversation, so recall survives a reload or a restart.
 *
 * `previous` and `next` return the entry to show, or undefined when there is
 * nowhere further to go. Walking forward past the newest entry returns the
 * draft that was being typed when browsing began.
 */
export type HistoryCursor<T> = {
  /** True between the first Up and the Down that returns to the draft. */
  browsing: () => boolean;
  previous: (current: T) => T | undefined;
  next: () => T | undefined;
  /** Forget the position, e.g. after a send. */
  reset: () => void;
};

export function createHistoryCursor<T>(entries: () => T[]): HistoryCursor<T> {
  let list: T[] = [];
  let index = -1; // -1 = not browsing
  let draft: T | undefined;

  return {
    browsing: () => index !== -1,
    previous(current) {
      if (index === -1) {
        list = entries();
        if (list.length === 0) return undefined;
        draft = current;
        index = list.length;
      }
      if (index === 0) return undefined;
      index -= 1;
      return list[index];
    },
    next() {
      if (index === -1) return undefined;
      index += 1;
      if (index >= list.length) {
        index = -1;
        return draft;
      }
      return list[index];
    },
    reset() {
      index = -1;
      draft = undefined;
    },
  };
}
