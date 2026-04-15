import type { LogLevel } from '@nr-ai-observatory/shared';

export interface CliOptions {
  readonly port: number;
  readonly config: string | null;
  readonly logLevel: LogLevel;
  readonly stdio: boolean;
}

export interface ServerOptions {
  readonly name: string;
  readonly version: string;
}
