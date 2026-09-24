import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { closeSessionBuffer } from '@/features/buffers/actions';
import { COMMANDS } from '@/features/composer/commands';
import { useComposerStore } from '@/features/composer/composerStore';
import {
  formatShortcut,
  isMacLike,
  currentPlatform,
  shortcutById,
} from '@/features/shortcuts/shortcuts';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { cn } from '@/lib/cn';
import { disconnectNetwork } from '@/lib/ipc';
import { THEME_MODES } from '@/lib/theme';
import { orderedBuffers, useSessionStore } from '@/store/session';
import { useUiStore } from '@/store/ui';

import { filterEntries, stepIndex, type Searchable } from './matching';

/** How many entries to show per group. */
const GROUP_LIMIT = 20;

type GroupId = 'buffers' | 'actions' | 'commands';

interface PaletteEntry extends Searchable {
  id: string;
  detail?: string;
  shortcut?: string;
  run: () => void;
}

interface Group {
  id: GroupId;
  entries: PaletteEntry[];
}

/** The id an option carries in the DOM, so `aria-activedescendant` can point at it. */
function optionId(entryId: string): string {
  return `palette-option-${entryId}`;
}

/**
 * Build everything the palette can do.
 *
 * Rebuilt when the buffers or the layout change rather than kept in a store: it
 * is a projection of other state, and a cached copy would be one more thing to
 * invalidate.
 */
function usePaletteGroups(): Group[] {
  const { t } = useTranslation();

  const buffers = useSessionStore((state) => state.buffers);
  const networks = useSessionStore((state) => state.networks);
  const activeBufferId = useSessionStore((state) => state.activeBufferId);

  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const toggleMembers = useUiStore((state) => state.toggleMembers);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const membersOpen = useUiStore((state) => state.membersOpen);
  const themeMode = useUiStore((state) => state.themeMode);
  const language = useUiStore((state) => state.language);

  const mac = useMemo(() => isMacLike(currentPlatform()), []);

  /** How a shortcut is written here, or nothing if the id is unknown. */
  const shortcutLabel = (id: string): string => {
    const spec = shortcutById(id);
    return spec ? formatShortcut(spec, mac) : '';
  };

  return useMemo(() => {
    const session = useSessionStore.getState();
    const ui = useUiStore.getState();

    const activeBuffer = buffers.find((buffer) => buffer.id === activeBufferId) ?? null;
    const activeNetwork =
      networks.find((network) => network.id === activeBuffer?.networkId) ?? null;

    const bufferEntries: PaletteEntry[] = orderedBuffers(networks, buffers).map((buffer) => {
      const network = networks.find((candidate) => candidate.id === buffer.networkId);
      const label = buffer.kind === 'server' ? t('sidebar.server') : buffer.target;

      return {
        id: `buffer:${buffer.id}`,
        label,
        detail: network?.name,
        keywords: `${buffer.target} ${network?.name ?? ''}`,
        run: () => useSessionStore.getState().selectBuffer(buffer.id),
      };
    });

    const actionEntries: PaletteEntry[] = [
      {
        id: 'action:focus-composer',
        label: t('palette.actions.focusComposer'),
        run: () => useComposerStore.getState().requestFocus(),
      },
      {
        id: 'action:toggle-sidebar',
        label: t(sidebarOpen ? 'palette.actions.hideSidebar' : 'palette.actions.showSidebar'),
        shortcut: shortcutLabel('sidebar.toggle'),
        run: toggleSidebar,
      },
      {
        id: 'action:toggle-members',
        label: t(membersOpen ? 'palette.actions.hideMembers' : 'palette.actions.showMembers'),
        shortcut: shortcutLabel('members.toggle'),
        run: toggleMembers,
      },
      {
        id: 'action:theme',
        label: t('palette.actions.cycleTheme', { theme: t(`theme.${nextTheme(themeMode)}`) }),
        keywords: THEME_MODES.join(' '),
        run: () => ui.setThemeMode(nextTheme(themeMode)),
      },
      {
        id: 'action:language',
        label: t('palette.actions.switchLanguage', {
          language: nextLanguage(language) === 'zh-CN' ? '中文' : 'English',
        }),
        run: () => ui.setLanguage(nextLanguage(language)),
      },
      {
        id: 'action:connect',
        label: t('palette.actions.connect'),
        run: () => ui.setConnectionDialogOpen(true),
      },
    ];

    if (activeBuffer) {
      actionEntries.push(
        {
          id: 'action:close-buffer',
          label: t('palette.actions.closeBuffer'),
          shortcut: shortcutLabel('buffer.close'),
          run: () => void closeSessionBuffer(activeBuffer).catch(logFailure),
        },
        {
          id: 'action:clear-buffer',
          label: t('palette.actions.clearBuffer'),
          run: () => session.clearBuffer(activeBuffer.id),
        },
      );
    }

    if (activeNetwork) {
      actionEntries.push({
        id: 'action:disconnect',
        label: t('palette.actions.disconnect', { network: activeNetwork.name }),
        run: () =>
          void disconnectNetwork(activeNetwork.id)
            .then(() => useSessionStore.getState().removeNetwork(activeNetwork.id))
            .catch(logFailure),
      });
    }

    // Slash commands are inserted rather than run: most of them need arguments,
    // and guessing them would be worse than one keystroke.
    const commandEntries: PaletteEntry[] = COMMANDS.map((spec) => ({
      id: `command:${spec.name}`,
      label: `/${spec.name}`,
      detail: spec.usage,
      keywords: `${spec.aliases.join(' ')} ${t(`composer.commands.${spec.descriptionKey}`)}`,
      run: () => {
        const text = spec.usage === '' ? `/${spec.name}` : `/${spec.name} `;

        // Without a buffer there is nowhere to type; the command list is still
        // worth browsing, so this is a no-op rather than an error.
        if (activeBufferId === null) return;

        useComposerStore.getState().insert(activeBufferId, text);
        useComposerStore.getState().requestFocus();
      },
    }));

    return [
      { id: 'buffers', entries: bufferEntries },
      { id: 'actions', entries: actionEntries },
      { id: 'commands', entries: commandEntries },
    ];
  }, [
    t,
    buffers,
    networks,
    activeBufferId,
    sidebarOpen,
    membersOpen,
    themeMode,
    language,
    toggleSidebar,
    toggleMembers,
    mac,
  ]);
}

function logFailure(error: unknown): void {
  console.error('[ircuit] 命令面板操作失败', error);
}

/** The theme that comes after this one when cycling. */
export function nextTheme(current: string): (typeof THEME_MODES)[number] {
  const index = THEME_MODES.indexOf(current as (typeof THEME_MODES)[number]);
  return THEME_MODES[(index + 1) % THEME_MODES.length]!;
}

/** The language to switch to, given the current one. */
export function nextLanguage(current: string): (typeof SUPPORTED_LANGUAGES)[number] {
  const index = SUPPORTED_LANGUAGES.indexOf(current as (typeof SUPPORTED_LANGUAGES)[number]);
  return SUPPORTED_LANGUAGES[(index + 1) % SUPPORTED_LANGUAGES.length]!;
}

export function CommandPalette() {
  const { t } = useTranslation();

  const open = useUiStore((state) => state.paletteOpen);
  const setOpen = useUiStore((state) => state.setPaletteOpen);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const groups = usePaletteGroups();

  // Filter within each group, so the group order the user sees is stable while
  // the ranking still does its job inside a group.
  const visible = useMemo<Group[]>(
    () =>
      groups
        .map((group) => ({
          id: group.id,
          entries: filterEntries(group.entries, query, GROUP_LIMIT),
        }))
        .filter((group) => group.entries.length > 0),
    [groups, query],
  );

  const flat = useMemo(() => visible.flatMap((group) => group.entries), [visible]);

  /**
   * Headings and options in one flat list.
   *
   * `role="option"` elements have to be owned by the listbox, so a nested list
   * per group would be invalid ARIA. Flattening also lets the keyboard selection
   * stay a single index while the rendering keeps its headings.
   */
  type Row =
    | { kind: 'heading'; id: string; label: string }
    | { kind: 'option'; id: string; entry: PaletteEntry };

  const rows = useMemo<Row[]>(() => {
    const result: Row[] = [];

    for (const group of visible) {
      result.push({
        kind: 'heading',
        id: `heading:${group.id}`,
        label: t(`palette.groups.${group.id}`),
      });
      for (const entry of group.entries) {
        result.push({ kind: 'option', id: `row:${entry.id}`, entry });
      }
    }

    return result;
  }, [visible, t]);

  // A new query invalidates the old selection, and the top hit is what the user
  // is looking at.
  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const current = flat[selected] ?? null;

  const run = (entry: PaletteEntry) => {
    setOpen(false);
    entry.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setSelected((index) => stepIndex(index, 1, flat.length));
        break;

      case 'ArrowUp':
        event.preventDefault();
        setSelected((index) => stepIndex(index, -1, flat.length));
        break;

      case 'Enter':
        event.preventDefault();
        if (current) run(current);
        break;

      case 'Escape':
        event.preventDefault();
        setOpen(false);
        break;

      default:
        break;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      // Clicking the backdrop dismisses, which is what every palette does.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onKeyDown={onKeyDown}
        className="flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.placeholder')}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={current ? optionId(current.id) : undefined}
          className="shrink-0 border-b border-line bg-transparent px-3.5 py-2.5 text-[14px] text-ink outline-none placeholder:text-faint"
        />

        <ul id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {flat.length === 0 ? (
            <li role="presentation" className="px-3.5 py-3 text-[12.5px] text-faint">
              {t('palette.empty')}
            </li>
          ) : null}

          {rows.map((row) => {
            if (row.kind === 'heading') {
              return (
                <li
                  key={row.id}
                  role="presentation"
                  className="px-3.5 pb-0.5 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint"
                >
                  {row.label}
                </li>
              );
            }

            const { entry } = row;
            const active = entry.id === current?.id;

            return (
              <li
                key={row.id}
                id={optionId(entry.id)}
                role="option"
                aria-selected={active}
                onMouseEnter={() => setSelected(flat.indexOf(entry))}
                onMouseDown={(event) => {
                  // Keep focus in the input: blurring would close the dialog
                  // before the click is handled.
                  event.preventDefault();
                  run(entry);
                }}
                className={cn(
                  'flex cursor-pointer items-baseline gap-2 px-3.5 py-1.5 text-[13px]',
                  active ? 'bg-subtle text-ink' : 'text-muted',
                )}
              >
                <span className="shrink-0 font-mono">{entry.label}</span>
                {entry.detail ? (
                  <span className="truncate text-[11.5px] text-faint">{entry.detail}</span>
                ) : null}
                {entry.shortcut ? (
                  <span className="ml-auto shrink-0 pl-2 text-[11px] text-faint">
                    {entry.shortcut}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
