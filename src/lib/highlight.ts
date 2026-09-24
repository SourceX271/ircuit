/**
 * Deciding whether a line is worth interrupting someone for.
 *
 * Lives in `lib` rather than in a store or a feature because both need it: the
 * session store stamps every incoming line with `highlight`, and the settings
 * side owns the rule list. Putting it in either one would make the other import
 * across layers, and the session store importing a feature is the kind of
 * dependency that turns into a cycle the moment that feature wants a buffer.
 */

/** A word the user asked to be told about. */
export interface HighlightRule {
  /** Literal text to look for. Not a regular expression: a stray `(` in a
   * nickname should not make the rule throw. */
  pattern: string;
  caseSensitive: boolean;
  /** Require the characters around the match not to be word characters. */
  wholeWord: boolean;
  enabled: boolean;
}

/** What a new rule gets unless the caller says otherwise. */
export const RULE_DEFAULTS = {
  caseSensitive: false,
  wholeWord: true,
  enabled: true,
} as const;

/** Characters that count as part of a word for the whole-word check. */
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * The identity of a rule.
 *
 * The folded pattern *is* the identity, so adding the same word twice updates
 * one rule rather than stacking two — which is what a user typing
 * `/highlight rust` twice means.
 */
export function ruleKey(rule: Pick<HighlightRule, 'pattern'>): string {
  return rule.pattern.trim().toLowerCase();
}

export function createRule(
  pattern: string,
  overrides: Partial<Omit<HighlightRule, 'pattern'>> = {},
): HighlightRule {
  return { pattern: pattern.trim(), ...RULE_DEFAULTS, ...overrides };
}

/** Whether the characters around `index` are outside a word. */
function isWholeWordAt(haystack: string, index: number, length: number): boolean {
  const before = index === 0 ? '' : (haystack[index - 1] ?? '');
  const after = haystack[index + length] ?? '';

  return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
}

/**
 * Whether a rule matches.
 *
 * The boundary check is deliberately ASCII-only. IRC is an ASCII protocol and
 * nicknames cannot contain anything else, while CJK text has no spaces: treating
 * a Chinese character as a word character would make a Chinese keyword
 * unmatched in the middle of a sentence, which is the opposite of useful.
 */
export function matchesRule(text: string, rule: HighlightRule): boolean {
  if (!rule.enabled || rule.pattern === '') return false;

  const haystack = rule.caseSensitive ? text : text.toLowerCase();
  const needle = rule.caseSensitive ? rule.pattern : rule.pattern.toLowerCase();

  let index = haystack.indexOf(needle);
  while (index >= 0) {
    if (!rule.wholeWord || isWholeWordAt(haystack, index, needle.length)) return true;
    index = haystack.indexOf(needle, index + 1);
  }

  return false;
}

/**
 * Whether the text mentions `nick` as a word-ish token.
 *
 * Nicknames may contain RFC 1459's special characters — `[ ] \ ^ { } |` and the
 * backtick — so `[me]` is one token and must not count as a mention of `me`.
 */
export function mentions(text: string, nick: string | null): boolean {
  if (!nick) return false;

  const haystack = text.toLowerCase();
  const needle = nick.toLowerCase();
  if (!haystack.includes(needle)) return false;

  let index = haystack.indexOf(needle);
  while (index >= 0) {
    const before = index === 0 ? '' : haystack[index - 1]!;
    const after = haystack[index + needle.length] ?? '';
    const isNickChar = (ch: string) => /[a-z0-9_\-[\]\\^{}|`]/.test(ch);

    if (!isNickChar(before) && !isNickChar(after)) return true;
    index = haystack.indexOf(needle, index + 1);
  }

  return false;
}

/** Whether a line should be highlighted: it names us, or it hits a rule. */
export function isHighlight(
  text: string,
  selfNick: string | null,
  rules: readonly HighlightRule[],
): boolean {
  if (mentions(text, selfNick)) return true;
  return rules.some((rule) => matchesRule(text, rule));
}
