/**
 * Finding links inside message text.
 *
 * Messages come from strangers, so this errs towards finding *fewer* links: the
 * click handler opens whatever it is given in the user's browser, and a false
 * positive is a link someone did not intend to offer.
 */

/** A run of plain text, or a clickable link. */
export interface TextToken {
  kind: 'text' | 'link';
  value: string;
}

/**
 * Matches absolute URLs and bare `www.` hosts.
 *
 * Deliberately excludes anything with a scheme we would not open anyway, so a
 * `javascript:` or `file:` reference is simply rendered as text.
 */
const URL_PATTERN = /(?:https?:\/\/|ircs?:\/\/|www\.)[^\s<>"'`]+/gi;

/** Punctuation that is usually sentence structure rather than part of the URL. */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '"', "'"]);

/**
 * Split text into plain and link tokens.
 *
 * Adjacent plain runs are preserved exactly, so the caller can render the
 * result without losing whitespace.
 */
export function tokenizeLinks(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let cursor = 0;

  // `matchAll` needs the global flag; the pattern is shared, so reset first.
  URL_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const candidate = match[0];
    const { url, trailing } = splitTrailingPunctuation(candidate);

    // A bare `www.` with nothing after it is not a link.
    if (url === '' || url === 'www.') continue;

    if (start > cursor) {
      tokens.push({ kind: 'text', value: text.slice(cursor, start) });
    }

    tokens.push({ kind: 'link', value: url });
    if (trailing !== '') {
      tokens.push({ kind: 'text', value: trailing });
    }

    cursor = start + candidate.length;
  }

  if (cursor < text.length) {
    tokens.push({ kind: 'text', value: text.slice(cursor) });
  }

  return tokens;
}

/**
 * Peel off punctuation that belongs to the sentence, not the URL.
 *
 * A closing bracket is only removed when it is unbalanced: Wikipedia links end
 * in `)` often enough that stripping it eagerly would break them.
 */
export function splitTrailingPunctuation(candidate: string): { url: string; trailing: string } {
  let end = candidate.length;
  let trailing = '';

  while (end > 0) {
    const ch = candidate[end - 1] as string;

    if (TRAILING_PUNCTUATION.has(ch)) {
      end -= 1;
      trailing = ch + trailing;
      continue;
    }

    if (ch === ')') {
      const body = candidate.slice(0, end);
      const opens = (body.match(/\(/g) ?? []).length;
      const closes = (body.match(/\)/g) ?? []).length;

      if (closes > opens) {
        end -= 1;
        trailing = ch + trailing;
        continue;
      }
    }

    break;
  }

  return { url: candidate.slice(0, end), trailing };
}

/** The URL to actually open for a token. */
export function hrefFor(value: string): string {
  // A bare `www.` host has no scheme; the opener requires one.
  return /^www\./i.test(value) ? `https://${value}` : value;
}
