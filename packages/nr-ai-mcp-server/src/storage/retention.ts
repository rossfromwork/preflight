import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '@nr-ai-observatory/shared';

const logger = createLogger('retention');

export function purgeOldSessions(storagePath: string, retainDays: number): number {
  const sessionsDir = resolve(storagePath, 'sessions');
  const cutoffMs = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  let files: string[];
  try {
    files = readdirSync(sessionsDir);
  } catch {
    return 0; // sessions directory doesn't exist yet
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const fullPath = resolve(sessionsDir, file);
    try {
      const stat = statSync(fullPath);
      if (stat.mtimeMs < cutoffMs) {
        unlinkSync(fullPath);
        deletedCount++;
        logger.debug('Purged old session file', { file, ageDays: Math.floor((Date.now() - stat.mtimeMs) / 86_400_000) });
      }
    } catch (err) {
      logger.warn('Failed to check/delete session file', { file, error: String(err) });
    }
  }

  if (deletedCount > 0) {
    logger.info('Purged old session files', { count: deletedCount, retainDays });
  }

  return deletedCount;
}
