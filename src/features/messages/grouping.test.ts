import { describe, expect, it } from 'vitest';

import { buildBlocks, dayKey, GROUP_WINDOW_SECONDS, shouldGroup } from './grouping';
import type { SessionLine } from '@/store/session';

const BASE = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;

function line(overrides: Partial<SessionLine> = {}): SessionLine {
  return {
    id: `line-${Math.random()}`,
    nick: 'alice',
    kind: 'message',
    text: 'hello',
    segments: [],
    timestamp: BASE,
    isSelf: false,
    highlight: false,
    ...overrides,
  };
}

describe('dayKey', () => {
  it('is stable within a day and different across days', () => {
    expect(dayKey(BASE)).toBe(dayKey(BASE + 3600));
    expect(dayKey(BASE)).not.toBe(dayKey(BASE + 86400));
  });
});

describe('shouldGroup', () => {
  it('groups the same sender within the window', () => {
    expect(shouldGroup(line(), line({ timestamp: BASE + 60 }))).toBe(true);
  });

  it('starts a new group for a different sender', () => {
    expect(shouldGroup(line(), line({ nick: 'bob', timestamp: BASE + 60 }))).toBe(false);
  });

  it('matches senders case-insensitively', () => {
    expect(
      shouldGroup(line({ nick: 'Alice' }), line({ nick: 'alice', timestamp: BASE + 60 })),
    ).toBe(true);
  });

  it('starts a new group after a long silence', () => {
    const later = BASE + GROUP_WINDOW_SECONDS + 1;
    expect(shouldGroup(line(), line({ timestamp: later }))).toBe(false);
  });

  it('groups right up to the window boundary', () => {
    expect(shouldGroup(line(), line({ timestamp: BASE + GROUP_WINDOW_SECONDS }))).toBe(true);
  });

  it('never groups notices or system lines', () => {
    // Folding a notice into a neighbour's run would visually attribute it to
    // that neighbour.
    expect(shouldGroup(line(), line({ kind: 'notice', timestamp: BASE + 1 }))).toBe(false);
    expect(shouldGroup(line({ kind: 'notice' }), line({ timestamp: BASE + 1 }))).toBe(false);
    expect(shouldGroup(line(), line({ kind: 'system', timestamp: BASE + 1 }))).toBe(false);
  });

  it('groups actions with messages', () => {
    expect(shouldGroup(line(), line({ kind: 'action', timestamp: BASE + 1 }))).toBe(true);
  });

  it('refuses to group out-of-order lines', () => {
    // A negative gap means the log is not in time order; grouping would join
    // lines that are not adjacent.
    expect(shouldGroup(line({ timestamp: BASE }), line({ timestamp: BASE - 60 }))).toBe(false);
  });

  it('starts a new group for the first line', () => {
    expect(shouldGroup(null, line())).toBe(false);
  });
});

describe('buildBlocks', () => {
  it('labels the first day', () => {
    const blocks = buildBlocks([line()]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.daySeparator).toBe(dayKey(BASE));
    expect(blocks[0]?.rows).toHaveLength(1);
    expect(blocks[0]?.rows[0]?.startsGroup).toBe(true);
  });

  it('keeps a burst in one block with a single labelled row', () => {
    const blocks = buildBlocks([
      line({ timestamp: BASE }),
      line({ timestamp: BASE + 10 }),
      line({ timestamp: BASE + 20 }),
    ]);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.rows.map((row) => row.startsGroup)).toEqual([true, false, false]);
  });

  it('starts a new block when the sender changes', () => {
    const blocks = buildBlocks([
      line({ timestamp: BASE }),
      line({ nick: 'bob', timestamp: BASE + 10 }),
    ]);

    expect(blocks).toHaveLength(2);
    // Only the first block announces the day.
    expect(blocks[0]?.daySeparator).toBe(dayKey(BASE));
    expect(blocks[1]?.daySeparator).toBeNull();
  });

  it('announces each new day', () => {
    const blocks = buildBlocks([
      line({ timestamp: BASE }),
      line({ timestamp: BASE + 86400 }),
      line({ timestamp: BASE + 2 * 86400 }),
    ]);

    expect(blocks.map((block) => block.daySeparator !== null)).toEqual([true, true, true]);
  });

  it('rebuilds a group after a long silence', () => {
    const blocks = buildBlocks([
      line({ timestamp: BASE }),
      line({ timestamp: BASE + GROUP_WINDOW_SECONDS + 1 }),
    ]);

    expect(blocks).toHaveLength(2);
  });

  it('returns nothing for an empty log', () => {
    expect(buildBlocks([])).toEqual([]);
  });

  it('preserves every line', () => {
    const lines = [
      line({ timestamp: BASE }),
      line({ timestamp: BASE + 1 }),
      line({ nick: 'bob', timestamp: BASE + 2 }),
      line({ kind: 'system', timestamp: BASE + 3 }),
    ];

    const rows = buildBlocks(lines).flatMap((block) => block.rows);
    expect(rows.map((row) => row.line)).toEqual(lines);
  });
});
