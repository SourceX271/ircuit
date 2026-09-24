/**
 * In-app notifications, and the rules that decide what deserves one.
 *
 * In-app only, by decision: desktop notifications, the tray and sounds bring
 * three platforms' permission models with them and belong to M8. What is here is
 * a bounded stack of banners the user can click to jump to the line that caused
 * it, plus the keyword rules that decide what lands in it.
 *
 * Both live in one store because they are two halves of the same question — the
 * rules are useless without somewhere to surface a hit, and the stack has nothing
 * to show without the rules.
 */

import { create } from 'zustand';

import { createRule, isHighlight, ruleKey, type HighlightRule } from '@/lib/highlight';
import { HIGHLIGHT_RULES_KEY, persistJson, readStoredJson } from '@/lib/prefs';

/** One banner in the stack. */
export interface AppNotification {
  id: string;
  /** Buffer the line belongs to, so clicking can jump there. */
  bufferId: string;
  bufferLabel: string;
  networkId: string;
  networkName: string;
  nick: string;
  /** Plain text of the line, already trimmed by the store. */
  text: string;
  /** Unix seconds. */
  timestamp: number;
}

/** How many banners to keep. Beyond this the unread badges carry the signal. */
export const MAX_NOTIFICATIONS = 20;

/** How many to show at once before the stack becomes a wall. */
export const VISIBLE_NOTIFICATIONS = 3;

/** Validate one persisted rule, rejecting anything malformed. */
function parseRule(value: unknown): HighlightRule | null {
  if (typeof value !== 'object' || value === null) return null;

  const candidate = value as Partial<HighlightRule>;
  if (typeof candidate.pattern !== 'string' || candidate.pattern.trim() === '') return null;

  return createRule(candidate.pattern, {
    caseSensitive: candidate.caseSensitive === true,
    wholeWord: candidate.wholeWord !== false,
    enabled: candidate.enabled !== false,
  });
}

/** Validate the persisted rule list, dropping entries that do not survive. */
export function parseRules(value: unknown): HighlightRule[] | null {
  if (!Array.isArray(value)) return null;

  const rules: HighlightRule[] = [];
  for (const entry of value) {
    const rule = parseRule(entry);
    if (rule) rules.push(rule);
  }

  return rules;
}

export interface NotificationsState {
  rules: HighlightRule[];
  notifications: AppNotification[];

  /** Add a rule, replacing any rule with the same pattern. */
  addRule: (rule: HighlightRule) => void;
  removeRule: (pattern: string) => void;
  setRules: (rules: HighlightRule[]) => void;
  /** Forget every rule. */
  clearRules: () => void;

  notify: (notification: AppNotification) => void;
  dismiss: (id: string) => void;
  clearNotifications: () => void;
}

let notificationSequence = 0;

/** A fresh id for a banner. */
export function nextNotificationId(): string {
  notificationSequence += 1;
  return `notice-${notificationSequence}`;
}

/** Reset the id counter. Test-only. */
export function resetNotificationSequence(): void {
  notificationSequence = 0;
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  rules: readStoredJson(window.localStorage, HIGHLIGHT_RULES_KEY, parseRules, []),
  notifications: [],

  addRule: (rule) => {
    set((state) => {
      const key = ruleKey(rule);
      const rules = state.rules.filter((existing) => ruleKey(existing) !== key);
      const next = [...rules, rule];

      persistJson(window.localStorage, HIGHLIGHT_RULES_KEY, next);
      return { rules: next };
    });
  },

  removeRule: (pattern) => {
    set((state) => {
      const key = pattern.trim().toLowerCase();
      const next = state.rules.filter((rule) => ruleKey(rule) !== key);

      persistJson(window.localStorage, HIGHLIGHT_RULES_KEY, next);
      return { rules: next };
    });
  },

  setRules: (rules) => {
    persistJson(window.localStorage, HIGHLIGHT_RULES_KEY, rules);
    set({ rules });
  },

  clearRules: () => {
    persistJson(window.localStorage, HIGHLIGHT_RULES_KEY, []);
    set({ rules: [] });
  },

  notify: (notification) => {
    set((state) => {
      const next = [...state.notifications, notification];

      // Oldest first out: the badges in the sidebar are the durable record, and
      // an unbounded stack would eventually cover the message list.
      if (next.length > MAX_NOTIFICATIONS) next.splice(0, next.length - MAX_NOTIFICATIONS);

      return { notifications: next };
    });
  },

  dismiss: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((notification) => notification.id !== id),
    }));
  },

  clearNotifications: () => set({ notifications: [] }),
}));

/**
 * Whether a line should raise a banner.
 *
 * Only for buffers the user is not looking at: a banner about the line already
 * on screen is pure noise. Our own lines never qualify, and a bare mention in a
 * join/part line is not something to interrupt anyone for.
 */
export function shouldNotify(options: {
  text: string;
  selfNick: string | null;
  rules: readonly HighlightRule[];
  isSelf: boolean;
  isActivity: boolean;
  isActiveBuffer: boolean;
}): boolean {
  if (options.isSelf || !options.isActivity || options.isActiveBuffer) return false;
  return isHighlight(options.text, options.selfNick, options.rules);
}
