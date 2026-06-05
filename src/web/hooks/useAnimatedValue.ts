import { useState, useEffect, useRef } from 'react';

interface AnimatedValueOptions {
  readonly duration?: number;
  readonly decimals?: number;
  readonly enabled?: boolean;
}

function supportsAnimation(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useAnimatedValue(target: number, options: AnimatedValueOptions = {}): string {
  const { duration = 800, decimals = 0, enabled = true } = options;
  const shouldAnimate = enabled && supportsAnimation();

  const [current, setCurrent] = useState<number>(() => (shouldAnimate ? 0 : target));
  const hasAnimated = useRef(false);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!shouldAnimate || hasAnimated.current) {
      setCurrent(target);
      return;
    }

    hasAnimated.current = true;
    const start = performance.now();

    function tick(now: number): void {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setCurrent(eased * target);

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration, shouldAnimate]);

  return current.toFixed(decimals);
}
