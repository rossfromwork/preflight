import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';
import { useLiveStore, type AlertEvent } from '../store/liveStore';

function fireOne(overrides: Partial<AlertEvent> = {}): void {
  useLiveStore.getState().addOrUpdateAlert({
    id: 'rule-x',
    state: 'firing',
    severity: 'warning',
    title: 'Rule',
    description: '',
    value: 1,
    threshold: 0,
    firedAt: 0,
    ...overrides,
  });
}

function resetStore(): void {
  useLiveStore.setState({
    connected: false,
    recentToolCalls: [],
    cost: null,
    antiPatterns: [],
    firingAlerts: new Map(),
    dismissedAlerts: new Set(),
  });
}

describe('Sidebar', () => {
  beforeEach(() => {
    resetStore();
  });
  afterEach(() => {
    resetStore();
  });

  it('renders all four nav items', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('History')).toBeInTheDocument();
    expect(screen.getByText('Audit')).toBeInTheDocument();
  });

  it('highlights the active item', () => {
    render(<Sidebar currentPath="/audit" onNavigate={() => {}} connected={true} />);
    const audit = screen.getByText('Audit').closest('button');
    expect(audit).toHaveAttribute('aria-current', 'page');
  });

  it('shows ● connected when connected=true', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
  });

  it('shows ● reconnecting when connected=false', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={false} />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });

  it('does not set aria-current on inactive items', () => {
    render(<Sidebar currentPath="/audit" onNavigate={() => {}} connected={true} />);
    for (const label of ['Today', 'Sessions', 'History']) {
      const btn = screen.getByText(label).closest('button')!;
      expect(btn.hasAttribute('aria-current')).toBe(false);
    }
  });

  it('marks decorative icons aria-hidden inside nav buttons', () => {
    const { container } = render(
      <Sidebar currentPath="/" onNavigate={() => {}} connected={true} />,
    );
    const icons = container.querySelectorAll('nav button svg');
    expect(icons.length).toBe(4);
    for (const svg of Array.from(icons)) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('labels the nav landmarks as "Observe" and "Analyze"', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    expect(screen.getByRole('navigation', { name: 'Observe' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Analyze' })).toBeInTheDocument();
  });

  it('does not render an alert badge when no alerts are firing', () => {
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    expect(screen.queryByTestId('alert-badge')).toBeNull();
  });

  it('shows a numeric badge on Today when alerts are firing', () => {
    fireOne({ id: 'a', severity: 'warning' });
    fireOne({ id: 'b', severity: 'warning' });
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    const badge = screen.getByTestId('alert-badge');
    expect(badge.textContent).toBe('2');
    expect(badge).toHaveAttribute('aria-label', '2 firing alerts');
  });

  it('uses a singular aria-label when there is one alert', () => {
    fireOne({ id: 'a', severity: 'warning' });
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    expect(screen.getByTestId('alert-badge')).toHaveAttribute('aria-label', '1 firing alert');
  });

  it('tones the badge with the highest severity present', () => {
    fireOne({ id: 'a', severity: 'warning' });
    fireOne({ id: 'b', severity: 'critical' });
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    const badge = screen.getByTestId('alert-badge');
    expect(badge.getAttribute('data-severity')).toBe('critical');
    expect(badge.className).toContain('text-accent-red');
  });

  it('caps the badge text at 99+ when alert count exceeds 99', () => {
    for (let i = 0; i < 100; i += 1) {
      fireOne({ id: `alert-${i}`, severity: 'warning' });
    }
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    const badge = screen.getByTestId('alert-badge');
    expect(badge.textContent).toBe('99+');
    expect(badge).toHaveAttribute('aria-label', '99+ firing alerts');
  });

  it('shows the raw count for badges at or below 99', () => {
    for (let i = 0; i < 99; i += 1) {
      fireOne({ id: `alert-${i}`, severity: 'warning' });
    }
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    expect(screen.getByTestId('alert-badge').textContent).toBe('99');
  });

  it('only shows the badge on the Today nav item, not on others', () => {
    fireOne({ id: 'a', severity: 'warning' });
    render(<Sidebar currentPath="/" onNavigate={() => {}} connected={true} />);
    const todayBtn = screen.getByText('Today').closest('button')!;
    expect(todayBtn.querySelector('[data-testid="alert-badge"]')).not.toBeNull();
    for (const label of ['Sessions', 'History', 'Audit']) {
      const btn = screen.getByText(label).closest('button')!;
      expect(btn.querySelector('[data-testid="alert-badge"]')).toBeNull();
    }
  });
});
