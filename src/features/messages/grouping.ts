/**
 * Grouping consecutive lines and inserting day separators.
 *
 * A chat log reads badly as a wall of identical rows: repeating the nickname and
 * the timestamp on every line of a three-line burst is noise, and a session that
 * spans days has no sense of where one day ends. Both are presentation
 * concerns, so both live here as pure functions over the stored lines.
 */

import type { SessionLine } from '@/store/session';

/** How long a silence still counts as the same burst of messages. */
export const GROUP_WINDOW_SECONDS = 5 * 60;

/** One rendered line. */
export interface DisplayRow {
  line: SessionLine;
  /** Whether this row starts a group, and therefore shows the sender. */
  startsGroup: boolean;
}

/** A run of rows that share a day and a sender. */
export interface DisplayBlock {
  /** The day to announce above this block, or `null` when it continues one. */
  daySeparator: string | null;
  rows: DisplayRow[];
}

/** The local calendar day of a timestamp, as `YYYY-MM-DD`. */
export function dayKey(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Whether `next` continues `previous`'s group.
 *
 * Only ordinary messages and actions group. A notice or a system line always
 * stands alone, because folding it into a neighbour's run would visually
 * attribute it to that neighbour.
 */
export function shouldGroup(previous: SessionLine | null, next: SessionLine): boolean {
  if (previous === null) return false;

  const groupable = (line: SessionLine) => line.kind === 'message' || line.kind === 'action';
  if (!groupable(previous) || !groupable(next)) return false;

  if (previous.nick.toLowerCase() !== next.nick.toLowerCase()) return false;

  const gap = next.timestamp - previous.timestamp;
  // A negative gap means the clock moved or the log is out of order; grouping
  // would then join lines that are not actually adjacent in time.
  if (gap < 0 || gap > GROUP_WINDOW_SECONDS) return false;

  return dayKey(previous.timestamp) === dayKey(next.timestamp);
}

/**
 * Split lines into blocks with day separators.
 *
 * The first block always carries a separator, so a log never starts with an
 * unlabelled day.
 */
export function buildBlocks(lines: readonly SessionLine[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  let current: DisplayBlock | null = null;
  let previous: SessionLine | null = null;

  for (const line of lines) {
    const isNewDay = previous === null || dayKey(previous.timestamp) !== dayKey(line.timestamp);
    const startsGroup = isNewDay || !shouldGroup(previous, line);

    if (current === null || startsGroup) {
      current = { daySeparator: isNewDay ? dayKey(line.timestamp) : null, rows: [] };
      blocks.push(current);
    }

    current.rows.push({ line, startsGroup });
    previous = line;
  }

  return blocks;
}
