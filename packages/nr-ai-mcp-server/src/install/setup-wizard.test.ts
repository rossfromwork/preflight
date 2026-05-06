import { describe, it, expect } from '@jest/globals';
import { buildConfig } from './setup-wizard.js';

describe('buildConfig', () => {
  it('merges new fields with existing config', () => {
    const result = buildConfig(
      { appName: 'my-app', existingField: 'keep-me' },
      { accountId: '12345', licenseKey: 'nrlic', developer: 'alice', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(result.accountId).toBe('12345');
    expect(result.existingField).toBe('keep-me');
  });

  it('omits teamId when null', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(Object.keys(result)).not.toContain('teamId');
  });

  it('includes teamId when provided', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: 'eng', projectId: null, sessionBudgetUsd: null },
    );
    expect(result.teamId).toBe('eng');
  });

  it('omits projectId when null', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(Object.keys(result)).not.toContain('projectId');
  });

  it('includes projectId when provided', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: 'org/repo', sessionBudgetUsd: null },
    );
    expect(result.projectId).toBe('org/repo');
  });

  it('omits sessionBudgetUsd when null', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(Object.keys(result)).not.toContain('sessionBudgetUsd');
  });

  it('includes sessionBudgetUsd when provided', () => {
    const result = buildConfig(
      {},
      { accountId: '1', licenseKey: 'k', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: 5.0 },
    );
    expect(result.sessionBudgetUsd).toBe(5.0);
  });

  it('overwrites existing accountId with new value', () => {
    const result = buildConfig(
      { accountId: 'old', licenseKey: 'old-key' },
      { accountId: 'new', licenseKey: 'new-key', developer: 'd', teamId: null, projectId: null, sessionBudgetUsd: null },
    );
    expect(result.accountId).toBe('new');
    expect(result.licenseKey).toBe('new-key');
  });
});
