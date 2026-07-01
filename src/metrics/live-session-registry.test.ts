import { LiveSessionRegistry } from './live-session-registry.js';

describe('LiveSessionRegistry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns touched sessions as live', () => {
    const reg = new LiveSessionRegistry();
    reg.touch('sess-a');
    reg.touch('sess-b');
    expect(reg.getLiveSessions()).toEqual(expect.arrayContaining(['sess-a', 'sess-b']));
    expect(reg.getLiveSessions()).toHaveLength(2);
  });

  it('isLive returns true for recently touched sessions', () => {
    const reg = new LiveSessionRegistry();
    reg.touch('sess-a');
    expect(reg.isLive('sess-a')).toBe(true);
    expect(reg.isLive('unknown')).toBe(false);
  });

  it('prunes sessions older than threshold from getLiveSessions', () => {
    const reg = new LiveSessionRegistry(5000);
    reg.touch('sess-a');
    jest.advanceTimersByTime(6000);
    expect(reg.getLiveSessions()).toEqual([]);
  });

  it('isLive returns false after threshold and prunes entry', () => {
    const reg = new LiveSessionRegistry(5000);
    reg.touch('sess-a');
    jest.advanceTimersByTime(6000);
    expect(reg.isLive('sess-a')).toBe(false);
  });

  it('refreshes liveness on repeated touch', () => {
    const reg = new LiveSessionRegistry(5000);
    reg.touch('sess-a');
    jest.advanceTimersByTime(4000);
    reg.touch('sess-a');
    jest.advanceTimersByTime(4000);
    expect(reg.isLive('sess-a')).toBe(true);
  });

  it('handles mix of live and stale sessions', () => {
    const reg = new LiveSessionRegistry(5000);
    reg.touch('sess-old');
    jest.advanceTimersByTime(4000);
    reg.touch('sess-new');
    jest.advanceTimersByTime(2000);
    // sess-old: 6000ms ago (stale), sess-new: 2000ms ago (live)
    expect(reg.getLiveSessions()).toEqual(['sess-new']);
  });

  it('returns empty array when no sessions touched', () => {
    const reg = new LiveSessionRegistry();
    expect(reg.getLiveSessions()).toEqual([]);
  });

  it('reset() clears all tracked sessions', () => {
    const reg = new LiveSessionRegistry();
    reg.touch('sess-a');
    reg.touch('sess-b');
    reg.reset();
    expect(reg.getLiveSessions()).toEqual([]);
    expect(reg.isLive('sess-a')).toBe(false);
  });

  describe('concurrency tracking', () => {
    it('tracks peak concurrent sessions via touch()', () => {
      const reg = new LiveSessionRegistry(5000);
      reg.touch('a');
      reg.touch('b');
      reg.touch('c');
      expect(reg.getPeakConcurrent()).toBe(3);
    });

    it('getConcurrentCount() returns current live count', () => {
      const reg = new LiveSessionRegistry(5000);
      reg.touch('a');
      reg.touch('b');
      expect(reg.getConcurrentCount()).toBe(2);
      jest.advanceTimersByTime(6000);
      expect(reg.getConcurrentCount()).toBe(0);
    });

    it('peak persists even after sessions go stale', () => {
      const reg = new LiveSessionRegistry(5000);
      reg.touch('a');
      reg.touch('b');
      reg.touch('c');
      jest.advanceTimersByTime(6000);
      expect(reg.getConcurrentCount()).toBe(0);
      expect(reg.getPeakConcurrent()).toBe(3);
    });

    it('startSampling() records time series entries', () => {
      const reg = new LiveSessionRegistry(60_000);
      reg.touch('a');
      reg.startSampling();
      jest.advanceTimersByTime(30_000);
      const ts = reg.getConcurrencyTimeSeries();
      expect(ts.length).toBe(1);
      expect(ts[0]!.count).toBe(1);
      reg.stopSampling();
    });

    it('stopSampling() halts recording', () => {
      const reg = new LiveSessionRegistry(60_000);
      reg.startSampling();
      jest.advanceTimersByTime(30_000);
      reg.stopSampling();
      jest.advanceTimersByTime(60_000);
      expect(reg.getConcurrencyTimeSeries().length).toBe(1);
    });

    it('time series caps at max buffer size', () => {
      const reg = new LiveSessionRegistry();
      reg.touch('a');
      reg.startSampling();
      jest.advanceTimersByTime(30_000 * 2900);
      const ts = reg.getConcurrencyTimeSeries();
      expect(ts.length).toBeLessThanOrEqual(2880);
      reg.stopSampling();
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-session visibility contract
  //
  // These tests verify that concurrent sessions from multiple AI tools all appear
  // in the live registry simultaneously. This is the contract that underlies the
  // Today page showing multiple concurrent sessions. Platform-agnostic: the registry
  // doesn't care about Claude Code vs Antigravity vs anything else — all touched
  // sessions must be visible.
  // ---------------------------------------------------------------------------
  describe('multi-session visibility contract', () => {
    it('tracks all concurrent sessions simultaneously', () => {
      const reg = new LiveSessionRegistry();
      reg.touch('session-1');
      reg.touch('session-2');
      reg.touch('session-3');

      const live = reg.getLiveSessions();
      expect(live).toHaveLength(3);
      expect(live).toEqual(expect.arrayContaining(['session-1', 'session-2', 'session-3']));
    });

    it('derives session names from cwd for all concurrent sessions', () => {
      const reg = new LiveSessionRegistry();
      reg.touch('session-A', '/home/user/project-alpha');
      reg.touch('session-B', '/home/user/project-beta');
      reg.touch('session-C', '/home/user/project-gamma');

      expect(reg.getSessionName('session-A')).toBe('project-alpha');
      expect(reg.getSessionName('session-B')).toBe('project-beta');
      expect(reg.getSessionName('session-C')).toBe('project-gamma');
    });

    it('falls back to provided name when cwd is absent (Antigravity --print sessions)', () => {
      const reg = new LiveSessionRegistry();
      // agy --print sessions may not have a workspace path; use short UUID fallback
      reg.touch('agy-session-uuid', undefined, 'agy-sess');
      expect(reg.getSessionName('agy-session-uuid')).toBe('agy-sess');
    });

    it('upgrades fallback name to real cwd name when cwd arrives later', () => {
      const reg = new LiveSessionRegistry();
      // First touch has no cwd — fallback UUID registered
      reg.touch('sess-123', undefined, 'sess-123');
      expect(reg.getSessionName('sess-123')).toBe('sess-123');
      // Subsequent touch has a real workspace path — should upgrade
      reg.touch('sess-123', '/home/user/my-project');
      expect(reg.getSessionName('sess-123')).toBe('my-project');
    });

    it('all sessions remain visible after being updated (activity keeps them live)', () => {
      const reg = new LiveSessionRegistry(5000);
      reg.touch('sess-active');
      reg.touch('sess-also-active');
      jest.advanceTimersByTime(3000); // within threshold
      reg.touch('sess-active'); // keep alive
      jest.advanceTimersByTime(3000); // sess-also-active now stale, sess-active still live
      const live = reg.getLiveSessions();
      expect(live).toContain('sess-active');
      expect(live).not.toContain('sess-also-active');
    });

    it('peakConcurrent tracks the highest number of simultaneous sessions seen', () => {
      const reg = new LiveSessionRegistry();
      reg.touch('sess-1');
      reg.touch('sess-2');
      reg.touch('sess-3');
      // All 3 live at once
      expect(reg.getPeakConcurrent()).toBe(3);
    });
  });
});
