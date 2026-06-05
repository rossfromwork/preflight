import { useRef, useEffect, useId } from 'react';

export interface SparklineProps {
  readonly values: number[];
  readonly width?: number;
  readonly height?: number;
  readonly stroke?: string;
  readonly ariaLabel?: string;
  readonly animate?: boolean;
}

export function Sparkline({
  values,
  width = 280,
  height = 50,
  stroke = '#1CE783',
  ariaLabel,
  animate,
}: SparklineProps): JSX.Element | null {
  const hasAnimated = useRef<boolean>(false);
  const uid = useId();

  useEffect(() => {
    if (animate && !hasAnimated.current) {
      hasAnimated.current = true;
    }
  });

  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  // Area polygon: line points + bottom-right + bottom-left
  const areaPoints = `${points} ${width.toFixed(1)},${height} 0,${height}`;

  const gradientId = `spark-grad-${uid}`;
  const glowId = `spark-glow-${uid}`;

  const a11yProps = ariaLabel
    ? { role: 'img' as const, 'aria-label': describeSparkline(ariaLabel, values) }
    : { 'aria-hidden': true as const };

  const shouldAnimate = animate && !hasAnimated.current;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" height={height} {...a11yProps}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.25} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
        <filter id={glowId}>
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <polygon
        fill={`url(#${gradientId})`}
        points={areaPoints}
        className={shouldAnimate ? 'animate-sparkline-fill' : undefined}
      />
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        points={points}
        strokeLinecap="round"
        strokeLinejoin="round"
        filter={`url(#${glowId})`}
        pathLength={shouldAnimate ? 1 : undefined}
        className={shouldAnimate ? 'animate-sparkline-draw' : undefined}
      />
    </svg>
  );
}

function describeSparkline(label: string, values: number[]): string {
  const first = values[0];
  const last = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return `${label}: ${values.length} points, start ${fmt(first)}, end ${fmt(last)}, min ${fmt(min)}, max ${fmt(max)}`;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(1);
  return n.toFixed(2);
}
