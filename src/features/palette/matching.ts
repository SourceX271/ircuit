/**
 * Ranking for the command palette.
 *
 * A subsequence match, not a substring one: `/jn` should find `/join`, and
 * `#rt` should find `#rust`. Ranking is what makes the list feel right — an
 * exact prefix beats a scattered match, and a match at a word boundary beats
 * one buried in the middle.
 *
 * Pure and integer-scored on purpose. Fuzzy matchers are notoriously hard to
 * reason about by eye, so the scoring rules are small enough to test directly
 * and the tie-breaking is spelled out instead of left to sort stability.
 */

/** Anything searchable in the palette. */
export interface Searchable {
  /** Primary text, also the label shown. */
  label: string;
  /** Extra text that should match but is not shown as the label. */
  keywords?: string;
}

/** Where a character sits relative to a word boundary. */
const BOUNDARY = /[\s/#\-_.:]/;

const CONSECUTIVE_BONUS = 3;
const BOUNDARY_BONUS = 2;
const MATCH_SCORE = 1;

/**
 * Added to a match on the visible label.
 *
 * Bigger than any score a label can earn (each character contributes at most
 * `MATCH_SCORE + CONSECUTIVE_BONUS + BOUNDARY_BONUS`), which is what makes
 * "every label match outranks every keyword match" true by construction rather
 * than by a penalty that has to be re-tuned whenever a keyword gets longer.
 */
const LABEL_PRIORITY = 1_000_000;

/**
 * Score how well `query` matches `text`.
 *
 * Returns `-1` when the query is not a subsequence of the text, so callers can
 * filter and rank in the same pass.
 */
export function fuzzyScore(text: string, query: string): number {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  if (needle === '') return 0;
  if (needle.length > haystack.length) return -1;

  let score = 0;
  let cursor = 0;
  let previous = -2;

  for (let index = 0; index < haystack.length && cursor < needle.length; index += 1) {
    if (haystack[index] !== needle[cursor]) continue;

    score += MATCH_SCORE;
    // Rewards runs of adjacent characters and matches that start a word, which
    // is what separates "join" for the query "jo" from "Just nOtice".
    if (index === previous + 1) score += CONSECUTIVE_BONUS;
    if (index === 0 || BOUNDARY.test(haystack[index - 1]!)) score += BOUNDARY_BONUS;

    previous = index;
    cursor += 1;
  }

  return cursor === needle.length ? score : -1;
}

/** Score an entry against the label and its hidden keywords. */
export function scoreEntry(entry: Searchable, query: string): number {
  const label = fuzzyScore(entry.label, query);

  // A match on what the user can see always wins: otherwise typing a command
  // name would bury it under entries that merely mention it in their keywords.
  if (label >= 0) return label + LABEL_PRIORITY;

  if (entry.keywords === undefined || entry.keywords === '') return -1;

  return fuzzyScore(entry.keywords, query);
}

/**
 * Filter and rank entries.
 *
 * With an empty query the original order is kept — that order is deliberate
 * (recent buffers first, actions before commands), and re-sorting it would
 * throw that away for no reason.
 */
export function filterEntries<T extends Searchable>(
  entries: readonly T[],
  query: string,
  limit = Number.POSITIVE_INFINITY,
): T[] {
  if (query.trim() === '') return entries.slice(0, limit);

  const scored: { entry: T; score: number }[] = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, query.trim());
    if (score >= 0) scored.push({ entry, score });
  }

  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;

    // Same score: prefer the shorter label, then alphabetical, so the order is
    // total and does not depend on the input array.
    if (left.entry.label.length !== right.entry.label.length) {
      return left.entry.label.length - right.entry.label.length;
    }
    return left.entry.label.localeCompare(right.entry.label);
  });

  return scored.slice(0, limit).map((item) => item.entry);
}

/**
 * Move a selection index by `delta`, wrapping at both ends.
 *
 * Wrapping matters here: a palette is driven by two arrow keys, and stopping
 * dead at the last entry makes a long list feel broken.
 */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;

  return (current + delta + length) % length;
}
