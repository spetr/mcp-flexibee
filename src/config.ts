import { resolve } from 'node:path';
import { EVIDENCE_FIELDS } from './flexi/policy.ts';
import type { FlexiConfig } from './flexi/client.ts';

export interface AppConfig {
  connectionName: string;
  flexi?: FlexiConfig;
  corpusPath?: string;
  corpusHash?: string;
  corpusMaxAgeDays: number;
  auditPath: string;
  callsPerMinute: number;
}

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}

export function loadConfig(env: NodeJS.ProcessEnv, cwd = process.cwd(), lawOnly = false): AppConfig {
  const config: AppConfig = {
    connectionName: env.FLEXI_CONNECTION_NAME ?? 'main',
    auditPath: resolve(cwd, env.MCP_AUDIT_PATH ?? '.state/audit.jsonl'),
    callsPerMinute: integer(env.MCP_CALLS_PER_MINUTE, 60, 1, 600),
    corpusMaxAgeDays: integer(env.CZLAW_MAX_AGE_DAYS, 7, 1, 30),
  };
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.connectionName)) throw new ConfigError('Invalid FLEXI_CONNECTION_NAME.');
  const connection = [env.FLEXI_BASE_URL, env.FLEXI_COMPANY, env.FLEXI_USERNAME, env.FLEXI_PASSWORD];
  if (lawOnly && connection.some(value => value !== undefined)) throw new ConfigError('Law-only mode must run without Flexi credentials.');
  if (connection.some(value => value !== undefined)) {
    if (!connection.every(value => typeof value === 'string' && value.length > 0)) throw new ConfigError('Set all four FLEXI connection variables.');
    const allowedEvidences = (env.FLEXI_ALLOWED_EVIDENCES ?? 'faktura-vydana,faktura-prijata').split(',').map(value => value.trim());
    if (!allowedEvidences.length || new Set(allowedEvidences).size !== allowedEvidences.length || allowedEvidences.some(value => !Object.hasOwn(EVIDENCE_FIELDS, value))) throw new ConfigError('Invalid FLEXI_ALLOWED_EVIDENCES.');
    config.flexi = {
      baseUrl: env.FLEXI_BASE_URL!, company: env.FLEXI_COMPANY!, username: env.FLEXI_USERNAME!, password: env.FLEXI_PASSWORD!,
      allowedEvidences,
      timeoutMs: integer(env.FLEXI_TIMEOUT_MS, 15_000, 100, 60_000),
      maxResponseBytes: integer(env.FLEXI_MAX_RESPONSE_BYTES, 1_048_576, 1024, 4_194_304),
    };
  }
  if (env.CZLAW_CORPUS_PATH !== undefined || env.CZLAW_MANIFEST_SHA256 !== undefined) {
    if (!env.CZLAW_CORPUS_PATH || !/^[a-f0-9]{64}$/.test(env.CZLAW_MANIFEST_SHA256 ?? '')) throw new ConfigError('Set CZLAW_CORPUS_PATH and a pinned CZLAW_MANIFEST_SHA256 together.');
    config.corpusPath = resolve(cwd, env.CZLAW_CORPUS_PATH);
    config.corpusHash = env.CZLAW_MANIFEST_SHA256!;
  }
  return config;
}

function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError('Invalid numeric configuration.');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ConfigError('Numeric configuration outside permitted range.');
  return value;
}
