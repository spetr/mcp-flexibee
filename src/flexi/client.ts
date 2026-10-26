import { Buffer } from 'node:buffer';
import {
  checkKeys, compileFilters, evidenceFields, FlexiError, invalid, isObject,
  projectRecord, validateFields,
} from './policy.ts';
import type { FieldKind, FilterCondition } from './policy.ts';

export { EVIDENCE_FIELDS, FlexiError } from './policy.ts';
export type { FilterCondition, FilterOperator } from './policy.ts';

export interface FlexiConfig {
  baseUrl: string; company: string; username: string; password: string;
  allowedEvidences: readonly string[]; timeoutMs?: number; maxResponseBytes?: number;
}
export interface ListRecordsInput {
  evidence: string; fields: string[]; limit?: number; start?: number; filters?: FilterCondition[];
}
export interface GetRecordInput { evidence: string; id: string; fields: string[] }
export interface RecordsResult { records: Record<string, unknown>[]; rowCount?: number }
export interface SchemaProperty { name: string; type: FieldKind }
export interface SchemaResult { evidence: string; properties: SchemaProperty[] }
export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_BYTES = 1_048_576;

export class FlexiClient {
  readonly #origin: string;
  readonly #company: string;
  readonly #authorization: string;
  readonly #allowed: ReadonlySet<string>;
  readonly #timeout: number;
  readonly #maxBytes: number;
  readonly #fetch: FetchFunction;
  #active = 0;
  readonly #schemas = new Map<string, { expires: number; result: SchemaResult }>();

  constructor(config: FlexiConfig, fetchImplementation: FetchFunction = globalThis.fetch) {
    let base: URL;
    try { base = new URL(config.baseUrl); } catch { invalid('Configure a valid HTTPS origin.'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') invalid('Configure a bare HTTPS origin without credentials.');
    if (typeof config.company !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(config.company)) invalid('Invalid company identifier.');
    if (typeof config.username !== 'string' || !config.username || config.username.length > 256 || /[:\p{C}]/u.test(config.username) ||
        typeof config.password !== 'string' || !config.password || config.password.length > 4096 || /[\p{C}]/u.test(config.password)) invalid('Invalid API credentials.');
    if (!Array.isArray(config.allowedEvidences) || !config.allowedEvidences.length) invalid('Configure at least one permitted evidence.');
    for (const evidence of config.allowedEvidences) evidenceFields(evidence);
    this.#timeout = boundedInteger(config.timeoutMs ?? DEFAULT_TIMEOUT, 1, 60_000, 'Invalid timeout.');
    this.#maxBytes = boundedInteger(config.maxResponseBytes ?? DEFAULT_MAX_BYTES, 1, 10_485_760, 'Invalid response limit.');
    this.#origin = base.origin;
    this.#company = config.company;
    this.#authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
    this.#allowed = new Set(config.allowedEvidences);
    this.#fetch = fetchImplementation;
  }

  #validateEvidence(evidence: string): void {
    evidenceFields(evidence);
    if (!this.#allowed.has(evidence)) invalid('Evidence is not permitted for this connection.');
  }

  async listRecords(input: ListRecordsInput): Promise<RecordsResult> {
    checkKeys(input, ['evidence', 'fields', 'limit', 'start', 'filters']);
    this.#validateEvidence(input.evidence);
    const fields = validateFields(input.evidence, input.fields);
    const limit = boundedInteger(input.limit ?? 20, 1, 100, 'Limit must be between 1 and 100.');
    const start = boundedInteger(input.start ?? 0, 0, 10_000, 'Start must be between 0 and 10000.');
    const filter = compileFilters(input.evidence, input.filters);
    await this.#validateRuntimeFields(input.evidence, fields, input.filters);
    const suffix = filter ? `/(${encodeURIComponent(filter).replaceAll("'", '%27')}).json` : '.json';
    const url = this.#url(input.evidence, suffix);
    this.#recordQuery(url, fields, limit, start);
    return this.#records(await this.#request(url), input.evidence, fields, limit);
  }

  async getRecord(input: GetRecordInput): Promise<RecordsResult> {
    checkKeys(input, ['evidence', 'id', 'fields']);
    this.#validateEvidence(input.evidence);
    if (typeof input.id !== 'string' || !/^[1-9]\d{0,14}$/.test(input.id)) invalid('A numeric record ID is required.');
    const fields = validateFields(input.evidence, input.fields);
    // Always fetch an ID internally so a misrouted response cannot impersonate the requested record.
    const upstreamFields = fields.includes('id') ? fields : ['id', ...fields];
    await this.#validateRuntimeFields(input.evidence, upstreamFields);
    const url = this.#url(input.evidence, `/${input.id}.json`);
    this.#recordQuery(url, upstreamFields, 1, 0);
    const result = this.#records(await this.#request(url), input.evidence, upstreamFields, 1);
    for (const record of result.records) {
      if (String(record.id) !== input.id) throw new FlexiError('INVALID_RESPONSE', 'Record identifier does not match the request.');
    }
    result.records = result.records.map(record => projectRecord(input.evidence, record, fields));
    return result;
  }

  async schema(evidence: string): Promise<SchemaResult> {
    this.#validateEvidence(evidence);
    const cached = this.#schemas.get(evidence);
    if (cached && cached.expires > Date.now()) return cloneSchema(cached.result);
    const payload = await this.#request(this.#url(evidence, '/properties.json'));
    const result = parseSchema(evidence, payload);
    this.#schemas.set(evidence, { expires: Date.now() + 300_000, result });
    return cloneSchema(result);
  }

  async #validateRuntimeFields(evidence: string, fields: string[], filters?: FilterCondition[]): Promise<void> {
    const schema = await this.schema(evidence);
    const names = new Set(schema.properties.map(property => property.name));
    if ([...fields, ...(filters ?? []).map(filter => filter.field)].some(field => !names.has(field))) invalid('Field is unavailable in the configured Flexi company.');
  }

  #url(evidence: string, suffix: string): URL {
    const url = new URL(`/c/${this.#company}/${evidence}${suffix}`, this.#origin);
    url.searchParams.set('auth', 'http');
    return url;
  }

  #recordQuery(url: URL, fields: string[], limit: number, start: number): void {
    url.searchParams.set('detail', `custom:${fields.join(',')}`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('start', String(start));
    url.searchParams.set('order', 'id');
    if (start === 0) url.searchParams.set('add-row-count', 'true');
  }

  #records(payload: unknown, evidence: string, fields: string[], limit: number): RecordsResult {
    if (!isObject(payload) || !isObject(payload.winstrom)) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi response.');
    const envelope = payload.winstrom;
    const records = envelope[evidence];
    if (!Array.isArray(records) || records.length > limit) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi records.');
    const result: RecordsResult = { records: records.map(record => projectRecord(evidence, record, fields)) };
    if (envelope['@rowCount'] !== undefined) {
      const count = envelope['@rowCount'];
      if (typeof count !== 'string' || !/^\d{1,15}$/.test(count) || !Number.isSafeInteger(Number(count))) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi row count.');
      result.rowCount = Number(count);
    }
    return result;
  }

  async #request(url: URL): Promise<unknown> {
    // A full queue would retain unbounded work; callers receive a safe retry-later result instead.
    if (this.#active >= 4) throw new FlexiError('BUSY', 'Flexi connection is busy. Try again later.');
    this.#active++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timeoutReached = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timeoutReached = true;
        controller.abort();
        reject(new FlexiError('TIMEOUT', 'Flexi request timed out.'));
      }, this.#timeout);
    });
    try {
      const operation = async (): Promise<unknown> => {
        const response = await this.#fetch(url, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: this.#authorization },
        });
        if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== this.#origin)) {
          throw new FlexiError('UPSTREAM_ERROR', 'Flexi request failed.');
        }
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        if (mime !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(mime ?? '')) throw new FlexiError('INVALID_RESPONSE', 'Flexi did not return JSON.');
        const contentLength = response.headers.get('content-length');
        if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > this.#maxBytes)) throw new FlexiError('RESPONSE_TOO_LARGE', 'Flexi response exceeds the configured limit.');
        if (!response.body) throw new FlexiError('INVALID_RESPONSE', 'Flexi returned an empty response.');
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > this.#maxBytes) throw new FlexiError('RESPONSE_TOO_LARGE', 'Flexi response exceeds the configured limit.');
          chunks.push(chunk.value);
        }
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { throw new FlexiError('INVALID_RESPONSE', 'Flexi returned invalid JSON.'); }
      };
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      if (timeoutReached) throw new FlexiError('TIMEOUT', 'Flexi request timed out.');
      if (error instanceof FlexiError) throw error;
      throw new FlexiError('UPSTREAM_ERROR', 'Flexi request failed.');
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      if (reader) void reader.cancel().catch(() => undefined);
      this.#active--;
    }
  }
}

function boundedInteger(value: unknown, min: number, max: number, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(message);
  return value;
}

function cloneSchema(result: SchemaResult): SchemaResult {
  return { evidence: result.evidence, properties: result.properties.map(property => ({ ...property })) };
}

function parseSchema(evidence: string, payload: unknown): SchemaResult {
  // properties.json is a metadata envelope, never returned wholesale to the model.
  if (!isObject(payload)) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi schema.');
  // The supported codec is {properties:{property:[{propertyName:...}]}}.
  // Verify this envelope against the target instance before treating an
  // integration as live-tested. Display labels are never field identifiers.
  const container = payload.properties;
  const properties = isObject(container) ? container.property : undefined;
  if (!Array.isArray(properties) || properties.length > 500) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi schema.');
  const allowed = evidenceFields(evidence);
  const result: SchemaProperty[] = [];
  const seen = new Set<string>();
  for (const property of properties) {
    if (!isObject(property)) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi schema property.');
    const name = property.propertyName;
    if (typeof name !== 'string' || name.length > 128) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi schema property.');
    if (!Object.hasOwn(allowed, name)) continue;
    if (seen.has(name)) throw new FlexiError('INVALID_RESPONSE', 'Duplicate Flexi schema property.');
    seen.add(name);
    result.push({ name, type: allowed[name]! });
  }
  if (!result.length) throw new FlexiError('INVALID_RESPONSE', 'No permitted Flexi schema properties were found.');
  return { evidence, properties: result };
}
