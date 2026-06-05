import { useEffect, useRef } from 'react';

interface ShortcutConfig {
  readonly navigate: (path: string) => void;
  readonly onToggleHelp: () => void;
}

export function useKeyboardShortcuts({ navigate, onToggleHelp }: ShortcutConfig): void {
  const pendingRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      // Skip when focus is in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

      // Skip modified keys (let browser handle Cmd/Ctrl combos)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key;

      // Handle pending 'g' prefix sequence
      if (pendingRef.current === 'g') {
        pendingRef.current = null;
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }

        const routes: Record<string, string> = {
          h: '/',
          s: '/sessions',
          i: '/history',
          a: '/audit',
        };
        if (routes[key]) {
          e.preventDefault();
          navigate(routes[key]);
          return;
        }
      }

      // Start 'g' prefix
      if (key === 'g') {
        pendingRef.current = 'g';
        timerRef.current = setTimeout(() => {
          pendingRef.current = null;
        }, 500);
        return;
      }

      // Single-key shortcuts
      if (key === '?') {
        e.preventDefault();
        onToggleHelp();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [navigate, onToggleHelp]);
}
