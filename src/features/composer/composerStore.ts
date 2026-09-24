/**
 * Composer-local state: per-buffer drafts, input history and the "who spoke
 * last" lookup.
 *
 * Kept out of the session store on purpose. Nothing here comes from the backend
 * and nothing here should ever be persisted as session data — it is the part of
 * the input box that has to survive a buffer switch and nothing more. M3 is
 * where history and drafts become durable; until then this is deliberately
 * memory-only, which is why nothing here reaches for disk.
 */

import { create } from 'zustand';

import type { SessionLine } from '@/store/session';

/** How many sent lines to remember per buffer. */
export const HISTORY_LIMIT = 100;

export interface ComposerState {
  /** Unsent text, keyed by buffer id. */
  drafts: Record<string, string>;
  /** Sent lines, oldest first, keyed by buffer id. */
  history: Record<string, string[]>;

  setDraft: (bufferId: string, value: string) => void;
  /** Remember a line the user actually sent. */
  pushHistory: (bufferId: string, line: string) => void;
}

export const useComposerStore = create<ComposerState>((set) => ({
  drafts: {},
  history: {},

  setDraft: (bufferId, value) => {
    set((state) => {
      const drafts = { ...state.drafts };

      // An empty draft is the absence of a draft; storing `''` would grow the
      // map for every buffer the user ever visited and typed nothing in.
      if (value === '') delete drafts[bufferId];
      else drafts[bufferId] = value;

      return { drafts };
    });
  },

  pushHistory: (bufferId, line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;

    set((state) => {
      const existing = state.history[bufferId] ?? [];

      // Repeating a line — common when someone did not see an answer — should
      // not fill the history with copies of itself.
      if (existing[existing.length - 1] === line) return {};

      const next = [...existing, line];
      if (next.length > HISTORY_LIMIT) next.splice(0, next.length - HISTORY_LIMIT);

      return { history: { ...state.history, [bufferId]: next } };
    });
  },
}));

/** A position in the input history. `index === null` means "not browsing". */
export interface HistoryStep {
  index: number | null;
  value: string;
}

/**
 * Move one step through the history.
 *
 * `-1` walks towards older lines, `1` back towards the present. Reaching the end
 * returns the stashed line — whatever was half-typed when browsing started —
 * because losing an unsent message to an accidental ArrowDown is unforgivable
 * in a way that a stale history is not.
 *
 * Walking past the oldest entry clamps instead of wrapping: wrapping would
 * teleport the user from 1999 to the message they typed ten seconds ago.
 */
export function stepHistory(
  history: readonly string[],
  index: number | null,
  direction: -1 | 1,
  stash: string,
): HistoryStep {
  if (history.length === 0) return { index: null, value: stash };

  if (direction === -1) {
    const next = index === null ? history.length - 1 : Math.max(0, index - 1);
    return { index: next, value: history[next]! };
  }

  if (index === null) return { index: null, value: stash };

  const next = index + 1;
  if (next >= history.length) return { index: null, value: stash };

  return { index: next, value: history[next]! };
}

/**
 * The nickname of the most recent other person to speak in a buffer.
 *
 * Read from the rendered lines rather than tracked separately so it can never
 * disagree with what is on screen — including after lines are trimmed off the
 * front of the buffer.
 */
export function lastSpeakerOf(lines: readonly SessionLine[] | undefined): string | null {
  if (!lines) return null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.isSelf) continue;
    if (line.kind === 'message' || line.kind === 'action') return line.nick;
  }

  return null;
}

/**
 * Nicknames available for completion in a buffer.
 *
 * On a channel this is the member list — the server's NAMES reply, which is the
 * authoritative answer. In a query there is only the other party. On the server
 * buffer there is nobody, which is what stops Tab from inserting a nick into a
 * line that is about to be sent as a raw command.
 */
export function completionNicks(
  members: readonly { nick: string }[] | undefined,
  queryPartner: string | null,
): string[] {
  if (members && members.length > 0) return members.map((member) => member.nick);
  return queryPartner === null ? [] : [queryPartner];
}
