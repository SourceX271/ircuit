import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a hairline above this item, to group related actions. */
  separatorBefore?: boolean;
}

export interface ContextMenuProps {
  /** Viewport coordinates of the click that opened the menu. */
  x: number;
  y: number;
  items: readonly MenuItem[];
  onClose: () => void;
}

/**
 * A small popup menu anchored at a point.
 *
 * Dismissed by Escape, by clicking anywhere else, and by scrolling — a menu that
 * survives a scroll ends up pointing at nothing. Keyboard navigation is included
 * because a context menu is the only route to these actions.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState({ left: x, top: y });

  const enabled = items.filter((item) => !item.disabled);

  // Keep the menu inside the window: a right-click near the edge would otherwise
  // open it partly off-screen.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(x, window.innerWidth - rect.width - margin);
    const top = Math.min(y, window.innerHeight - rect.height - margin);

    setPosition({ left: Math.max(margin, left), top: Math.max(margin, top) });
  }, [x, y]);

  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((current) => {
          if (enabled.length === 0) return 0;
          return (current + step + enabled.length) % enabled.length;
        });
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        enabled[activeIndex]?.onSelect();
        onClose();
      }
    };

    // Capture, so a click on a row behind the menu still closes it.
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onClose, true);

    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [activeIndex, enabled, onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-orientation="vertical"
      style={{ left: position.left, top: position.top }}
      className="fixed z-50 min-w-[168px] rounded-lg border border-line bg-elevated py-1 shadow-2xl outline-none"
    >
      {items.map((item) => {
        const enabledIndex = enabled.indexOf(item);
        const active = enabledIndex >= 0 && enabledIndex === activeIndex;

        return (
          <div key={item.id}>
            {item.separatorBefore ? <div className="my-1 h-px bg-line" /> : null}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onMouseEnter={() => {
                if (enabledIndex >= 0) setActiveIndex(enabledIndex);
              }}
              onClick={() => {
                item.onSelect();
                onClose();
              }}
              className={cn(
                'flex w-full items-center px-3 py-1.5 text-left text-[12.5px] transition-colors',
                item.disabled
                  ? 'cursor-not-allowed text-faint'
                  : item.danger
                    ? 'text-danger hover:bg-danger/10'
                    : 'text-ink hover:bg-subtle',
                active && !item.disabled && (item.danger ? 'bg-danger/10' : 'bg-subtle'),
              )}
            >
              {item.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
