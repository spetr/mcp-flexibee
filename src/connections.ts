import { createHash } from 'node:crypto';
import { FlexiClient, FlexiError } from './flexi/client.ts';
import type { FetchFunction } from './flexi/client.ts';
import { OriginBudget, readCompanyJson } from './flexi/transport.ts';
import { isObject } from './flexi/policy.ts';
import type { AppConfig, ServerConfig } from './config.ts';

export interface TargetHandle {
  readonly target: string; readonly serverId: string; readonly companyId: string;
  readonly database: string; readonly label: string; readonly environment: 'production' | 'test';
  readonly credentialId: string; readonly revision: string;
  readonly allowedEvidences: readonly string[];
  readonly client: FlexiClient;
}
export interface ServerSummary {
  serverId: string; label: string; baseUrl: string; credentialIds: string[];
  limits: { maxConcurrentRequests: number; requestsPerMinute: number };
}
export interface TargetSummary {
  target: string; serverId: string; companyId: string; database: string; label: string;
  environment: 'production' | 'test'; credentialId: string; allowedEvidences: string[];
  state: string; accessible: boolean | null; companyName?: string;
}
export interface CompanyDiscovery { database: string; name: string; accessible: boolean; state: string; targets: string[] }
export interface CompanyPage { companies: CompanyDiscovery[]; nextOffset: number | null; truncated?: boolean }
interface Observation { state: string; accessible: boolean; companyName?: string }
interface DiscoverySnapshot { generation: number; companies: CompanyDiscovery[] }
interface DiscoveryCache extends DiscoverySnapshot { expires: number }
const DISCOVERY_TTL = 15_000;
const MAX_DISCOVERY_OFFSET = 10_000;

/** Routing is immutable for a process. There is no active/default-company state. */
export class ConnectionRegistry {
  readonly multi: boolean;
  readonly #servers = new Map<string, ServerConfig>();
  readonly #handles = new Map<string, TargetHandle>();
  readonly #budgets = new Map<string, OriginBudget>();
  readonly #fetch: FetchFunction;
  readonly #observations = new Map<string, Observation>();
  readonly #cache = new Map<string, DiscoveryCache>();
  readonly #inflight = new Map<string, Promise<DiscoverySnapshot>>();
  readonly #generations = new Map<string, number>();

  constructor(config: AppConfig, options: { fetch?: FetchFunction; legacyClient?: FlexiClient } = {}) {
    this.multi = config.servers !== undefined;
    this.#fetch = options.fetch ?? globalThis.fetch;
    let servers = config.servers ?? [];
    if (!this.multi && config.flexi) {
      const legacy = config.flexi;
      servers = [{ id: config.connectionName, label: config.connectionName, baseUrl: originOf(legacy.baseUrl),
        credentials: { legacy: { username: legacy.username, password: legacy.password } },
        companies: [{ id: 'main', label: legacy.company, database: legacy.company, credentialId: 'legacy', environment: 'production', allowedEvidences: [...legacy.allowedEvidences] }],
        limits: { maxConcurrentRequests: 4, requestsPerMinute: 60 }, timeoutMs: legacy.timeoutMs ?? 15_000, maxResponseBytes: legacy.maxResponseBytes ?? 1_048_576,
      }];
    }
    // Origin aliases share the most restrictive configured budget.
    const originLimits = new Map<string, { maxConcurrent: number; perMinute: number }>();
    for (const server of servers) {
      const origin = originOf(server.baseUrl);
      const previous = originLimits.get(origin);
      originLimits.set(origin, { maxConcurrent: Math.min(previous?.maxConcurrent ?? Infinity, server.limits.maxConcurrentRequests), perMinute: Math.min(previous?.perMinute ?? Infinity, server.limits.requestsPerMinute) });
    }
    for (const [origin, limits] of originLimits) this.#budgets.set(origin, new OriginBudget(limits.maxConcurrent, limits.perMinute));
    for (const original of servers) {
      const origin = originOf(original.baseUrl);
      const server: ServerConfig = Object.freeze({ ...original, baseUrl: origin,
        credentials: Object.freeze(Object.fromEntries(Object.entries(original.credentials).map(([key, value]) => [key, Object.freeze({ ...value })]))),
        companies: Object.freeze(original.companies.map(company => Object.freeze({ ...company, allowedEvidences: Object.freeze([...company.allowedEvidences]) }))),
        limits: Object.freeze({ ...original.limits }),
      });
      if (this.#servers.has(server.id)) throw new FlexiError('INVALID_INPUT', 'Duplicate configured API server.');
      this.#servers.set(server.id, server);
      for (const company of server.companies) {
        const target = `${server.id}/${company.id}`;
        const credential = server.credentials[company.credentialId];
        if (!credential || this.#handles.has(target)) throw new FlexiError('INVALID_INPUT', 'Invalid or duplicate configured target.');
        const routing = { target, origin, database: company.database, credentialId: company.credentialId, allowedEvidences: company.allowedEvidences };
        const client = !this.multi && options.legacyClient ? options.legacyClient : new FlexiClient({ baseUrl: origin, company: company.database, ...credential, allowedEvidences: [...company.allowedEvidences], timeoutMs: server.timeoutMs, maxResponseBytes: server.maxResponseBytes }, this.#fetch, this.#budgets.get(origin));
        const handle = Object.freeze({ target, serverId: server.id, companyId: company.id, database: company.database, label: company.label,
          environment: company.environment, credentialId: company.credentialId, allowedEvidences: Object.freeze([...company.allowedEvidences]),
          revision: createHash('sha256').update(JSON.stringify(routing)).digest('hex'), client,
        });
        this.#handles.set(target, handle);
      }
    }
  }

  servers(): ServerSummary[] {
    return [...this.#servers.values()].map(server => ({ serverId: server.id, label: server.label, baseUrl: server.baseUrl, credentialIds: Object.keys(server.credentials), limits: { ...server.limits } }));
  }

  targets(): TargetSummary[] {
    return [...this.#handles.values()].map(handle => {
      const observation = this.#observations.get(handle.target);
      return { target: handle.target, serverId: handle.serverId, companyId: handle.companyId, database: handle.database,
        label: handle.label, environment: handle.environment, credentialId: handle.credentialId, allowedEvidences: [...handle.allowedEvidences],
        state: observation?.state ?? 'unknown', accessible: observation?.accessible ?? null,
        ...(observation?.companyName ? { companyName: observation.companyName } : {}),
      };
    });
  }

  resolve(target?: string): TargetHandle {
    if (!this.#handles.size) throw new FlexiError('NOT_CONFIGURED', 'No Flexi target is configured.');
    if (target === undefined) {
      if (this.#handles.size !== 1) throw new FlexiError('TARGET_REQUIRED', 'Select an explicit target from flexi_target_list.');
      return this.#handles.values().next().value!;
    }
    if (typeof target !== 'string' || target.length > 129 || !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(target)) throw new FlexiError('TARGET_NOT_FOUND', 'Unknown Flexi target.');
    const handle = this.#handles.get(target);
    if (!handle) throw new FlexiError('TARGET_NOT_FOUND', 'Unknown Flexi target.');
    return handle;
  }

  async ensureReady(handle: TargetHandle): Promise<void> {
    if (this.#handles.get(handle.target) !== handle) throw new FlexiError('TARGET_NOT_FOUND', 'Unknown Flexi target.');
    // Preserve the original one-company integration and its injected fixture client.
    if (!this.multi) return;
    const snapshot = await this.#allCompanies(handle.serverId, handle.credentialId);
    this.#assertGeneration(this.#cacheKey(handle.serverId, handle.credentialId), snapshot.generation);
    const company = snapshot.companies.find(item => item.database === handle.database);
    if (!company || !company.accessible) {
      this.#observations.set(handle.target, { state: company?.state ?? 'NOT_VISIBLE', accessible: false, ...(company ? { companyName: company.name } : {}) });
      throw new FlexiError('COMPANY_NOT_VISIBLE', 'The configured company is not visible to this credential profile.');
    }
    if (company.state !== 'ESTABLISHED') throw new FlexiError('COMPANY_NOT_READY', 'The configured company is not ready for data access.');
  }

  async companies(serverId: string, credentialId?: string, start = 0, pageSize = 100): Promise<CompanyPage> {
    const result = await this.#companyPage(serverId, credentialId, start, pageSize);
    this.#assertGeneration(result.key, result.generation);
    return result.page;
  }

  async #companyPage(serverId: string, credentialId: string | undefined, start: number, pageSize: number): Promise<{ page: CompanyPage; generation: number; key: string }> {
    const { server, profile } = this.#profile(serverId, credentialId);
    if (!Number.isSafeInteger(start) || start < 0 || start > MAX_DISCOVERY_OFFSET || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new FlexiError('INVALID_INPUT', 'Invalid company discovery pagination.');
    const cacheKey = this.#cacheKey(server.id, profile);
    const generation = (this.#generations.get(cacheKey) ?? 0) + 1;
    this.#generations.set(cacheKey, generation);
    // A deliberate refresh must not retain a contradictory complete readiness snapshot.
    this.#cache.delete(cacheKey);
    const url = new URL('/c.json', server.baseUrl);
    url.searchParams.set('auth', 'http'); url.searchParams.set('limit', String(pageSize)); url.searchParams.set('start', String(start));
    const payload = await readCompanyJson(url, server, server.credentials[profile]!, this.#fetch, this.#budgets.get(server.baseUrl)!);
    const container = isObject(payload) ? payload.companies : undefined;
    let values = isObject(container) ? container.company : undefined;
    if (isObject(values)) values = [values];
    if (isObject(container) && values == null) values = [];
    if (!Array.isArray(values) || values.length > pageSize) throw new FlexiError('INVALID_RESPONSE', 'Invalid company discovery envelope.');
    const seen = new Set<string>();
    const companies = values.map(value => {
      if (!isObject(value) || typeof value.dbNazev !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.dbNazev) || seen.has(value.dbNazev)) throw new FlexiError('INVALID_RESPONSE', 'Invalid or duplicate company identifier.');
      seen.add(value.dbNazev);
      const name = safeText(value.nazev);
      const state = safeText(value.stavEnum) || 'UNKNOWN';
      const accessible = value.show === true || value.show === 'true';
      const targets = [...this.#handles.values()].filter(handle => handle.serverId === server.id && handle.credentialId === profile && handle.database === value.dbNazev).map(handle => handle.target);
      return { database: value.dbNazev, name, accessible, state, targets };
    });
    const next = companies.length === pageSize ? start + companies.length : null;
    const truncated = next !== null && next > MAX_DISCOVERY_OFFSET;
    const nextOffset = truncated ? null : next;
    // A slower old request must never publish after a newer refresh has started.
    this.#assertGeneration(cacheKey, generation);
    for (const company of companies) {
      for (const target of company.targets) this.#observations.set(target, { state: company.state, accessible: company.accessible, companyName: company.name });
    }
    // A single complete first page can also serve the short readiness cache.
    this.#cache.delete(cacheKey);
    if (!start && nextOffset === null && !truncated) this.#publishComplete(server.id, profile, { companies, generation });
    return { key: cacheKey, generation, page: { companies: companies.map(company => ({ ...company, targets: [...company.targets] })), nextOffset, ...(truncated ? { truncated: true } : {}) } };
  }

  #profile(serverId: string, credentialId?: string): { server: ServerConfig; profile: string } {
    const server = this.#servers.get(serverId);
    if (!server) throw new FlexiError('SERVER_NOT_FOUND', 'Unknown configured API server.');
    let profile = credentialId;
    if (profile === undefined) {
      const keys = Object.keys(server.credentials);
      if (keys.length !== 1) throw new FlexiError('CREDENTIAL_REQUIRED', 'Select a credential profile for company discovery.');
      profile = keys[0]!;
    }
    if (!Object.hasOwn(server.credentials, profile)) throw new FlexiError('CREDENTIAL_NOT_FOUND', 'Unknown credential profile.');
    return { server, profile };
  }

  #cacheKey(serverId: string, profile: string): string { return JSON.stringify([serverId, profile]); }

  #assertGeneration(key: string, generation: number): void {
    if (this.#generations.get(key) !== generation) throw new FlexiError('DISCOVERY_CHANGED', 'Company discovery changed during this request; retry with the current target state.');
  }

  #publishComplete(serverId: string, profile: string, snapshot: DiscoverySnapshot): void {
    const key = this.#cacheKey(serverId, profile);
    this.#assertGeneration(key, snapshot.generation);
    const visible = new Map(snapshot.companies.map(company => [company.database, company]));
    for (const handle of this.#handles.values()) {
      if (handle.serverId !== serverId || handle.credentialId !== profile) continue;
      const company = visible.get(handle.database);
      this.#observations.set(handle.target, company
        ? { state: company.state, accessible: company.accessible, companyName: company.name }
        : { state: 'NOT_VISIBLE', accessible: false });
    }
    this.#cache.set(key, { ...snapshot, expires: Date.now() + DISCOVERY_TTL });
  }

  async #allCompanies(serverId: string, profile: string): Promise<DiscoverySnapshot> {
    const key = this.#cacheKey(serverId, profile);
    const cached = this.#cache.get(key);
    if (cached && cached.expires > Date.now()) return cached;
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const pending = (async () => {
      const rows: CompanyDiscovery[] = [];
      const seen = new Set<string>();
      let start: number | null = 0;
      let generation = 0;
      while (start !== null) {
        if (start > MAX_DISCOVERY_OFFSET) throw new FlexiError('DISCOVERY_LIMIT', 'Company discovery exceeded its bounded pagination limit.');
        const result = await this.#companyPage(serverId, profile, start, 100);
        generation = result.generation;
        this.#assertGeneration(key, generation);
        const page = result.page;
        if (page.truncated) throw new FlexiError('DISCOVERY_LIMIT', 'Company discovery exceeded its bounded pagination limit.');
        for (const company of page.companies) {
          if (seen.has(company.database)) throw new FlexiError('INVALID_RESPONSE', 'Duplicate company across discovery pages.');
          seen.add(company.database); rows.push(company);
        }
        start = page.nextOffset;
      }
      this.#assertGeneration(key, generation);
      const snapshot = { generation, companies: rows };
      this.#publishComplete(serverId, profile, snapshot);
      return snapshot;
    })();
    this.#inflight.set(key, pending);
    try { return await pending; }
    finally { this.#inflight.delete(key); }
  }
}

function safeText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || /[\p{C}]/u.test(value)) return '';
  return value;
}

function originOf(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('origin');
    return url.origin;
  } catch { throw new FlexiError('INVALID_INPUT', 'Configure a bare HTTPS origin without credentials.'); }
}
