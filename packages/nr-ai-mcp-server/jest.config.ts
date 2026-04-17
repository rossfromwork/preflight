import type { Config } from 'jest';
import baseConfig from '../../jest.config.base.ts';

const config: Config = {
  ...baseConfig,
  displayName: 'nr-ai-mcp-server',
  maxWorkers: 1, // stdio integration test spawns child processes; parallel workers deadlock
  moduleNameMapper: {
    ...baseConfig.moduleNameMapper,
    '^@nr-ai-observatory/shared$': '<rootDir>/../shared/src/index.ts',
  },
};

export default config;
