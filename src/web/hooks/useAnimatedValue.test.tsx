/**
 * @jest-environment jsdom
 */
// jest-environment-jsdom is available via vitest's jsdom dep in node_modules.
// The web test suite is primarily run via `npx vitest run` (see vitest.config.ts),
// but this also passes under Jest when jest-environment-jsdom is available.

import { renderHook } from '@testing-library/react';
import { useAnimatedValue } from './useAnimatedValue';

// jsdom does not implement matchMedia, so supportsAnimation() returns false
// and the hook always returns the final value immediately.

describe('useAnimatedValue', () => {
  it('returns formatted target immediately in jsdom (no matchMedia)', () => {
    const { result } = renderHook(() => useAnimatedValue(42));
    expect(result.current).toBe('42');
  });

  it('respects decimals option', () => {
    const { result } = renderHook(() => useAnimatedValue(3.14159, { decimals: 2 }));
    expect(result.current).toBe('3.14');
  });

  it('returns target when enabled is false', () => {
    const { result } = renderHook(() => useAnimatedValue(100, { enabled: false }));
    expect(result.current).toBe('100');
  });

  it('updates when target changes', () => {
    const { result, rerender } = renderHook(({ target }) => useAnimatedValue(target), {
      initialProps: { target: 10 },
    });
    expect(result.current).toBe('10');

    rerender({ target: 20 });
    expect(result.current).toBe('20');
  });
});
