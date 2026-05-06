import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { purgeOldSessions } from './retention.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = resolve(tmpdir(), randomUUID());
  mkdirSync(resolve(dir, 'sessions'), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeSessionFile(storagePath: string, name: string): void {
  const path = resolve(storagePath, 'sessions', name);
  writeFileSync(path, JSON.stringify({ sessionId: name }), { mode: 0o600 });
  // Note: fs mtime reflects actual write time; Jest fake timers do not affect it.
  // Tests for "old file deletion" would require utimes() — omitted here.
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('purgeOldSessions', () => {
  it('returns 0 when sessions directory does not exist', () => {
    const dir = resolve(tmpdir(), randomUUID()); // never created
    expect(purgeOldSessions(dir, 30)).toBe(0);
  });

  it('does not delete recently-created files', () => {
    const dir = makeTempDir();
    writeSessionFile(dir, '2026-04-27_session1.json');
    const deleted = purgeOldSessions(dir, 30);
    expect(deleted).toBe(0);
    expect(existsSync(resolve(dir, 'sessions', '2026-04-27_session1.json'))).toBe(true);
  });

  it('returns 0 for empty sessions directory', () => {
    const dir = makeTempDir();
    expect(purgeOldSessions(dir, 30)).toBe(0);
  });

  it('ignores non-JSON files', () => {
    const dir = makeTempDir();
    writeFileSync(resolve(dir, 'sessions', 'readme.txt'), 'ignore me');
    expect(purgeOldSessions(dir, 0)).toBe(0); // 0 day retention: only .json deleted
  });

  it('deletes JSON files older than retainDays', () => {
    const dir = makeTempDir();
    const filePath = resolve(dir, 'sessions', '2026-01-01_old-session.json');
    writeFileSync(filePath, JSON.stringify({ sessionId: 'old' }), { mode: 0o600 });
    // Back-date mtime to 40 days ago
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    utimesSync(filePath, oldDate, oldDate);

    const deleted = purgeOldSessions(dir, 30);
    expect(deleted).toBe(1);
    expect(existsSync(filePath)).toBe(false);
  });

  it('keeps files younger than retainDays', () => {
    const dir = makeTempDir();
    const filePath = resolve(dir, 'sessions', '2026-01-01_recent-enough.json');
    writeFileSync(filePath, JSON.stringify({ sessionId: 'recent' }), { mode: 0o600 });
    // Back-date to 29 days ago — should be kept under 30-day retention
    const recentDate = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    utimesSync(filePath, recentDate, recentDate);

    const deleted = purgeOldSessions(dir, 30);
    expect(deleted).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });
});
