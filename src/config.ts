import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as z from 'zod';
import { EVIDENCE_FIELDS } from './flexi/policy.ts';
import type { FlexiConfig } from './flexi/client.ts';
import { INVOICE_HEADER_WRITE_FIELDS, INVOICE_ITEM_WRITE_FIELDS } from './flexi/client.ts';

export interface CredentialConfig { readonly username: string; readonly password: string }
export interface InvoiceWritePolicy { readonly enabled: boolean; readonly headerFields: readonly string[]; readonly itemFields: readonly string[] }
export interface CompanyConfig {
  readonly id: string; readonly label: string; readonly database: string;
  readonly credentialId: string; readonly environment: 'production' | 'test';
  readonly allowedEvidences: readonly string[];
  readonly writePolicy?: InvoiceWritePolicy;
}
export interface ServerConfig {
  readonly id: string; readonly label: string; readonly baseUrl: string;
  readonly credentials: Readonly<Record<string, CredentialConfig>>;
  readonly companies: readonly CompanyConfig[];
  readonly limits: { readonly maxConcurrentRequests: number; readonly requestsPerMinute: number };
  readonly timeoutMs: number; readonly maxResponseBytes: number;
}
export interface AppConfig {
  connectionName: string;
  flexi?: FlexiConfig;
  servers?: ServerConfig[];
  maxConcurrentCalls?: number;
  writeStorePath?: string;
  writeApprovalPublicKeyPath?: string;
  corpusPath?: string;
  corpusHash?: string;
  corpusMaxAgeDays: number;
  auditPath: string;
  callsPerMinute: number;
}

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigError'; }
}

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const label = z.string().min(1).max(200).refine(value => !/[\p{C}]/u.test(value));
const envRef = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const policy = z.array(z.string()).min(1).max(256).refine(values => new Set(values).size === values.length && (values.join(',') === '*' || values.every(value => Object.hasOwn(EVIDENCE_FIELDS, value))));
const multiSchema = z.strictObject({
  version: z.literal(1), readOnly: z.boolean(),
  write: z.strictObject({ storePath: z.string().min(1).max(2048), approvalPublicKeyPath: z.string().min(1).max(2048) }).optional(),
  limits: z.strictObject({ maxConcurrentCalls: z.number().int().min(1).max(16).default(4), callsPerMinute: z.number().int().min(1).max(600).default(60) }).default({ maxConcurrentCalls: 4, callsPerMinute: 60 }),
  servers: z.array(z.strictObject({
    id, label, baseUrl: z.string().min(1).max(2048),
    credentials: z.record(id, z.strictObject({ usernameEnv: envRef, passwordEnv: envRef })).refine(values => Object.keys(values).length > 0 && Object.keys(values).length <= 32),
    companies: z.array(z.strictObject({
      id, label, database: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/), credentialId: id,
      environment: z.enum(['production', 'test']), allowedEvidences: policy,
      writePolicy: z.strictObject({
        enabled: z.boolean(),
        headerFields: z.array(z.string()).max(40).refine(values => new Set(values).size === values.length && values.every(value => INVOICE_HEADER_WRITE_FIELDS.includes(value))).default([]),
        itemFields: z.array(z.string()).max(40).refine(values => new Set(values).size === values.length && values.every(value => INVOICE_ITEM_WRITE_FIELDS.includes(value))).default([]),
      }).optional(),
    })).min(1).max(256),
    limits: z.strictObject({ maxConcurrentRequests: z.number().int().min(1).max(16).default(4), requestsPerMinute: z.number().int().min(1).max(600).default(60) }).default({ maxConcurrentRequests: 4, requestsPerMinute: 60 }),
    timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
    maxResponseBytes: z.number().int().min(1024).max(4_194_304).default(1_048_576),
  })).min(1).max(32),
});

/** A bounded local file contains routing and secret references, never inline secrets. */
function readMultiConfig(path: string, env: NodeJS.ProcessEnv): { servers: ServerConfig[]; maxConcurrentCalls: number; callsPerMinute: number; writeStorePath?: string; writeApprovalPublicKeyPath?: string } {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1_048_576) throw new Error('size');
    const buffer = Buffer.alloc(1_048_577);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > 1_048_576) throw new Error('size');
    const parsed = multiSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))));
    const writable = parsed.servers.flatMap(server => server.companies).filter(company => company.writePolicy?.enabled);
    if (parsed.readOnly && writable.length) throw new Error('read-only write policy');
    if (!parsed.readOnly && (!parsed.write || !writable.length)) throw new Error('explicit scoped write configuration required');
    if (writable.some(company => company.allowedEvidences.join(',') !== '*' || !company.writePolicy || company.writePolicy.headerFields.length + company.writePolicy.itemFields.length === 0)) throw new Error('write schema policy');
    const servers = new Set<string>();
    const resolved = parsed.servers.map(server => {
      if (servers.has(server.id)) throw new Error('duplicate server');
      servers.add(server.id);
      const base = new URL(server.baseUrl);
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('origin');
      const credentials = Object.fromEntries(Object.entries(server.credentials).map(([key, ref]) => {
        const username = env[ref.usernameEnv]; const password = env[ref.passwordEnv];
        if (!username || username.length > 256 || /[:\p{C}]/u.test(username) || !password || password.length > 4096 || /[\p{C}]/u.test(password)) throw new Error('credential');
        return [key, Object.freeze({ username, password })];
      }));
      const companies = new Set<string>();
      for (const company of server.companies) {
        if (companies.has(company.id) || !Object.hasOwn(credentials, company.credentialId)) throw new Error('company');
        companies.add(company.id);
      }
      return Object.freeze({ ...server, baseUrl: base.origin, credentials: Object.freeze(credentials), companies: Object.freeze(server.companies.map(({ writePolicy, ...company }) => Object.freeze({ ...company, allowedEvidences: Object.freeze([...company.allowedEvidences]), ...(writePolicy ? { writePolicy: Object.freeze({ ...writePolicy, headerFields: Object.freeze([...writePolicy.headerFields]), itemFields: Object.freeze([...writePolicy.itemFields]) }) } : {}) }))), limits: Object.freeze({ ...server.limits }) });
    });
    return { servers: resolved, ...parsed.limits, ...(!parsed.readOnly && parsed.write ? { writeStorePath: resolve(dirname(path), parsed.write.storePath), writeApprovalPublicKeyPath: resolve(dirname(path), parsed.write.approvalPublicKeyPath) } : {}) };
  } catch {
    // Never serialize raw schema errors: they may contain paths or sensitive config values.
    throw new ConfigError('Invalid multi-server configuration, file permissions, or credential environment.');
  } finally { if (fd !== undefined) closeSync(fd); }
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
  if (env.FLEXI_CONFIG_PATH !== undefined) {
    if (lawOnly) throw new ConfigError('Law-only mode must run without Flexi configuration.');
    if (!env.FLEXI_CONFIG_PATH || [env.FLEXI_BASE_URL, env.FLEXI_COMPANY, env.FLEXI_CONNECTION_NAME].some(value => value !== undefined)) throw new ConfigError('Do not mix multi-server and legacy routing configuration.');
    const multi = readMultiConfig(resolve(cwd, env.FLEXI_CONFIG_PATH), env);
    config.servers = multi.servers;
    config.maxConcurrentCalls = multi.maxConcurrentCalls;
    if (multi.writeStorePath) config.writeStorePath = multi.writeStorePath;
    if (multi.writeApprovalPublicKeyPath) config.writeApprovalPublicKeyPath = multi.writeApprovalPublicKeyPath;
    config.callsPerMinute = integer(env.MCP_CALLS_PER_MINUTE, multi.callsPerMinute, 1, 600);
  } else {
    if (lawOnly && connection.some(value => value !== undefined)) throw new ConfigError('Law-only mode must run without Flexi credentials.');
    if (connection.some(value => value !== undefined)) {
      if (!connection.every(value => typeof value === 'string' && value.length > 0)) throw new ConfigError('Set all four FLEXI connection variables.');
      const allowedEvidences = (env.FLEXI_ALLOWED_EVIDENCES ?? 'faktura-vydana,faktura-prijata').split(',').map(value => value.trim());
      if (!allowedEvidences.length || new Set(allowedEvidences).size !== allowedEvidences.length || (allowedEvidences.join(',') !== '*' && allowedEvidences.some(value => !Object.hasOwn(EVIDENCE_FIELDS, value)))) throw new ConfigError('Invalid FLEXI_ALLOWED_EVIDENCES.');
      config.flexi = {
        baseUrl: env.FLEXI_BASE_URL!, company: env.FLEXI_COMPANY!, username: env.FLEXI_USERNAME!, password: env.FLEXI_PASSWORD!,
        allowedEvidences,
        timeoutMs: integer(env.FLEXI_TIMEOUT_MS, 15_000, 100, 60_000),
        maxResponseBytes: integer(env.FLEXI_MAX_RESPONSE_BYTES, 1_048_576, 1024, 4_194_304),
      };
    }
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
