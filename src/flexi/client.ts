import { Buffer } from 'node:buffer';
import {
  checkKeys, compileFilters, evidenceFields, FlexiError, invalid, isObject,
  projectRecord, validateFields,
} from './policy.ts';
import type { FieldKind, FilterCondition } from './policy.ts';
import { assertSegment, fieldPolicy, parseEvidences, parseProperties, parseRelations, permittedEvidence } from './metadata.ts';
import type { Evidence, Property, Relation } from './metadata.ts';
import { cancelBody } from './transport.ts';

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
export interface SchemaProperty extends Property {}
export interface SchemaResult { evidence: string; properties: SchemaProperty[] }
export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface SharedRequestBudget { acquire(): () => void }
export type WriteScalar = string | boolean;
export const INVOICE_HEADER_WRITE_FIELDS = Object.freeze(['popis', 'poznam', 'datVyst', 'datSplat', 'duzpPuv', 'duzpUcto', 'datUcto', 'typUcOp', 'primUcet', 'protiUcet', 'dphZaklUcet', 'dphSnizUcet', 'dphSniz2Ucet', 'clenDph', 'clenKonVykDph', 'statDph', 'uzpTuzemsko', 'stredisko', 'ucetni', 'stat']);
export const INVOICE_ITEM_WRITE_FIELDS = Object.freeze(['nazev', 'poznam', 'datUcto', 'typUcOp', 'zklMdUcet', 'zklDalUcet', 'dphMdUcet', 'dphDalUcet', 'clenDph', 'clenKonVykDph', 'dphPren', 'sazbaDph', 'szbDph', 'typSzbDphK', 'mnozMj', 'cenaMj', 'slevaPol', 'stredisko', 'ucetni', 'kopZklMdUcet', 'kopZklDalUcet', 'kopDphMdUcet', 'kopDphDalUcet', 'kopTypUcOp', 'kopStred', 'kopClenDph', 'kopDatUcto', 'kopClenKonVykDph']);
export interface ExistingInvoiceUpdate {
  id: string; lastUpdate: string; headerPatch: Record<string, WriteScalar>; previousHeader: Record<string, unknown>;
  items: { id: string; lastUpdate: string; patch: Record<string, WriteScalar>; previous: Record<string, unknown> }[];
  dryRun: boolean;
}

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
  readonly #budget: SharedRequestBudget | undefined;
  #active = 0;
  readonly #schemas = new Map<string, { expires: number; result: SchemaResult }>();
  readonly allRead: boolean;
  #catalog: { expires: number; values: Evidence[] } | undefined;
  readonly #relations = new Map<string, { expires: number; values: Relation[] }>();

  constructor(config: FlexiConfig, fetchImplementation: FetchFunction = globalThis.fetch, budget?: SharedRequestBudget) {
    let base: URL;
    try { base = new URL(config.baseUrl); } catch { invalid('Configure a valid HTTPS origin.'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') invalid('Configure a bare HTTPS origin without credentials.');
    if (typeof config.company !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(config.company)) invalid('Invalid company identifier.');
    if (typeof config.username !== 'string' || !config.username || config.username.length > 256 || /[:\p{C}]/u.test(config.username) ||
        typeof config.password !== 'string' || !config.password || config.password.length > 4096 || /[\p{C}]/u.test(config.password)) invalid('Invalid API credentials.');
    if (!Array.isArray(config.allowedEvidences) || !config.allowedEvidences.length) invalid('Configure at least one permitted evidence.');
    this.allRead = config.allowedEvidences.length === 1 && config.allowedEvidences[0] === '*';
    if (!this.allRead) for (const evidence of config.allowedEvidences) evidenceFields(evidence);
    this.#timeout = boundedInteger(config.timeoutMs ?? DEFAULT_TIMEOUT, 1, 60_000, 'Invalid timeout.');
    this.#maxBytes = boundedInteger(config.maxResponseBytes ?? DEFAULT_MAX_BYTES, 1, 10_485_760, 'Invalid response limit.');
    this.#origin = base.origin;
    this.#company = config.company;
    this.#authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
    this.#allowed = new Set(config.allowedEvidences);
    this.#fetch = fetchImplementation;
    this.#budget = budget;
  }

  #validateEvidence(evidence: string): void {
    if (this.allRead) {
      if (!permittedEvidence(evidence)) invalid('Evidence is not permitted for read access.');
      return;
    }
    evidenceFields(evidence);
    if (!this.#allowed.has(evidence)) invalid('Evidence is not permitted for this connection.');
  }

  async listRecords(input: ListRecordsInput): Promise<RecordsResult> {
    checkKeys(input, ['evidence', 'fields', 'limit', 'start', 'filters']);
    this.#validateEvidence(input.evidence);
    const policy = this.allRead ? fieldPolicy((await this.schema(input.evidence)).properties) : undefined;
    const fields = validateFields(input.evidence, input.fields, policy);
    const limit = boundedInteger(input.limit ?? 20, 1, 100, 'Limit must be between 1 and 100.');
    const start = boundedInteger(input.start ?? 0, 0, 10_000, 'Start must be between 0 and 10000.');
    const filter = compileFilters(input.evidence, input.filters, policy);
    await this.#validateRuntimeFields(input.evidence, fields, input.filters);
    const suffix = filter ? `/(${encodeURIComponent(filter).replaceAll("'", '%27')}).json` : '.json';
    const url = this.#url(input.evidence, suffix);
    this.#recordQuery(url, fields, limit, start, this.allRead ? (await this.schema(input.evidence)).properties : undefined);
    return this.#records(await this.#request(url), input.evidence, fields, limit, policy);
  }

  async getRecord(input: GetRecordInput): Promise<RecordsResult> {
    checkKeys(input, ['evidence', 'id', 'fields']);
    this.#validateEvidence(input.evidence);
    if (typeof input.id !== 'string' || !/^[1-9]\d{0,14}$/.test(input.id)) invalid('A numeric record ID is required.');
    const properties = this.allRead ? (await this.schema(input.evidence)).properties : undefined;
    const policy = properties ? fieldPolicy(properties) : undefined;
    const fields = validateFields(input.evidence, input.fields, policy);
    const identity = properties ? properties.find(p => p.primaryKey)?.name ?? properties.find(p => p.name === 'id')?.name ?? properties.find(p => p.name === 'idUcetniDenik')?.name : 'id';
    if (!identity) invalid('This register has no supported numeric record identity; use flexi_record_list.');
    // Always fetch an ID internally so a misrouted response cannot impersonate the requested record.
    const upstreamFields = fields.includes(identity) ? fields : [identity, ...fields];
    await this.#validateRuntimeFields(input.evidence, upstreamFields);
    const url = this.#url(input.evidence, `/${input.id}.json`);
    this.#recordQuery(url, upstreamFields, 1, 0, properties);
    const result = this.#records(await this.#request(url), input.evidence, upstreamFields, 1, policy);
    for (const record of result.records) {
      if (String(record[identity]) !== input.id) throw new FlexiError('INVALID_RESPONSE', 'Record identifier does not match the request.');
    }
    result.records = result.records.map(record => projectRecord(input.evidence, record, fields, policy));
    return result;
  }

  async schema(evidence: string, fresh = false): Promise<SchemaResult> {
    this.#validateEvidence(evidence);
    if (fresh) this.#schemas.delete(evidence);
    const cached = this.#schemas.get(evidence);
    if (cached && cached.expires > Date.now()) return cloneSchema(cached.result);
    if (this.allRead && !(await this.evidences()).some(item => item.evidence === evidence && item.access)) invalid('Evidence is unavailable for this API user.');
    const payload = await this.#request(this.#url(evidence, '/properties.json'));
    const result = this.allRead ? { evidence, properties: parseProperties(payload) } : parseSchema(evidence, payload);
    this.#schemas.set(evidence, { expires: Date.now() + 300_000, result });
    return cloneSchema(result);
  }

  /** Narrow update transport: existing purchase invoice and existing child IDs only. */
  async updateExistingInvoice(input: ExistingInvoiceUpdate): Promise<unknown> {
    this.#validateEvidence('faktura-prijata');
    const payload = buildExistingInvoicePayload(input);
    const url = this.#url('faktura-prijata', `/${input.id}.json`);
    url.searchParams.set('as-gui', 'true');
    url.searchParams.set('fail-on-warning', 'true');
    if (input.dryRun) url.searchParams.set('dry-run', 'true');
    return this.#request(url, { method: 'PUT', body: JSON.stringify(payload), dryRun: input.dryRun });
  }

  async evidences(): Promise<Evidence[]> {
    if (!this.allRead) return [...this.#allowed].map(evidence => ({ evidence, name: evidence, evidenceType: '', access: true, importStatus: '' }));
    if (!this.#catalog || this.#catalog.expires <= Date.now()) {
      const url = this.#url('evidence-list', '.json');
      url.searchParams.set('limit', '2000');
      this.#catalog = { expires: Date.now() + 300_000, values: parseEvidences(await this.#request(url)) };
    }
    return this.#catalog.values.map(item => ({ ...item }));
  }

  async relations(evidence: string): Promise<Relation[]> {
    this.#validateEvidence(evidence);
    if (!this.allRead) invalid('Relation discovery requires FLEXI_ALLOWED_EVIDENCES=*.');
    const catalog = await this.evidences();
    if (!catalog.some(item => item.evidence === evidence && item.access)) invalid('Evidence is unavailable for this API user.');
    let cached = this.#relations.get(evidence);
    if (!cached || cached.expires <= Date.now()) {
      cached = { expires: Date.now() + 300_000, values: parseRelations(await this.#request(this.#url(evidence, '/relations.json')), catalog) };
      this.#relations.set(evidence, cached);
    }
    return cached.values.map(item => ({ ...item }));
  }

  async listRelation(input: { evidence: string; id: string; relation: string; fields: string[]; limit?: number; start?: number; filters?: FilterCondition[] }): Promise<RecordsResult> {
    checkKeys(input, ['evidence', 'id', 'relation', 'fields', 'limit', 'start', 'filters']);
    this.#validateEvidence(input.evidence);
    assertSegment(input.relation);
    if (typeof input.id !== 'string' || !/^[1-9]\d{0,14}$/.test(input.id)) invalid('A numeric parent record ID is required.');
    const relation = (await this.relations(input.evidence)).find(item => item.name === input.relation);
    if (!relation) invalid('Relation is unavailable for this evidence and API user.');
    const policy = fieldPolicy((await this.schema(relation.evidence)).properties);
    const fields = validateFields(relation.evidence, input.fields, policy);
    const filter = compileFilters(relation.evidence, input.filters, policy);
    const limit = boundedInteger(input.limit ?? 20, 1, 100, 'Limit must be between 1 and 100.');
    const start = boundedInteger(input.start ?? 0, 0, 10_000, 'Start must be between 0 and 10000.');
    const suffix = `/${input.id}/${input.relation}${filter ? `/(${encodeURIComponent(filter).replaceAll("'", '%27')})` : ''}.json`;
    const url = this.#url(input.evidence, suffix);
    this.#recordQuery(url, fields, limit, start, (await this.schema(relation.evidence)).properties);
    return this.#records(await this.#request(url), relation.evidence, fields, limit, policy);
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

  #recordQuery(url: URL, fields: string[], limit: number, start: number, properties?: Property[]): void {
    url.searchParams.set('detail', `custom:${fields.join(',')}`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('start', String(start));
    const sortField = properties?.find(p => p.primaryKey)?.name ?? properties?.find(p => p.name === 'id' || p.name === 'idUcetniDenik')?.name ?? properties?.[0]?.name ?? 'id';
    url.searchParams.set('order', sortField);
    if (this.allRead) url.searchParams.set('use-internal-id', 'true');
    if (start === 0) url.searchParams.set('add-row-count', 'true');
  }

  #records(payload: unknown, evidence: string, fields: string[], limit: number, policy?: Readonly<Record<string, FieldKind>>): RecordsResult {
    if (!isObject(payload) || !isObject(payload.winstrom)) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi response.');
    const envelope = payload.winstrom;
    const records = envelope[evidence];
    if (!Array.isArray(records) || records.length > limit) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi records.');
    const result: RecordsResult = { records: records.map(record => projectRecord(evidence, record, fields, policy)) };
    if (envelope['@rowCount'] !== undefined) {
      const count = envelope['@rowCount'];
      if (typeof count !== 'string' || !/^\d{1,15}$/.test(count) || !Number.isSafeInteger(Number(count))) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi row count.');
      result.rowCount = Number(count);
    }
    return result;
  }

  async #request(url: URL, update?: { method: 'PUT'; body: string; dryRun: boolean }): Promise<unknown> {
    // A full queue would retain unbounded work; callers receive a safe retry-later result instead.
    if (this.#active >= 4) throw new FlexiError('BUSY', 'Flexi connection is busy. Try again later.');
    const release = this.#budget?.acquire();
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
          method: update?.method ?? 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: this.#authorization, ...(update ? { 'Content-Type': 'application/json' } : {}) },
          ...(update ? { body: update.body } : {}),
        });
        if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== this.#origin)) {
          if (update && response.status === 409) throw new FlexiError('WRITE_CONFLICT', 'Flexi rejected a stale document version.');
          if (update && response.status >= 400 && response.status < 500) throw new FlexiError('WRITE_REJECTED', 'Flexi rejected the invoice update.');
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
      await cancelBody(reader);
      this.#active--;
      release?.();
    }
  }
}

export function buildExistingInvoicePayload(input: ExistingInvoiceUpdate): Record<string, unknown> {
  checkKeys(input, ['id', 'lastUpdate', 'headerPatch', 'previousHeader', 'items', 'dryRun']);
  const row = (id: string, lastUpdate: string, patch: Record<string, WriteScalar>, previous: Record<string, unknown>, allowed: readonly string[]) => {
    if (typeof id !== 'string' || !/^[1-9]\d{0,14}$/.test(id) || typeof lastUpdate !== 'string' || lastUpdate.length > 128 || !/^\d{4}-\d{2}-\d{2}T/.test(lastUpdate) || /[\p{C}]/u.test(lastUpdate)) invalid('An exact existing ID and lastUpdate are required.');
    if (!isObject(patch) || !isObject(previous) || Object.keys(patch).length > 40) invalid('Invalid invoice patch.');
    const attributes: Record<string, unknown> = { '@create': 'fail', '@update': 'ok', id, lastUpdate };
    for (const [field, value] of Object.entries(patch)) {
      if (!allowed.includes(field) || !(typeof value === 'boolean' || (typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)))) invalid('Unsupported invoice patch field or value.');
      const old = previous[field];
      if (!(old === null || typeof old === 'string' || typeof old === 'boolean')) invalid('A previous value is required for every changed field.');
      attributes[field] = value;
      attributes[`${field}@previousValue`] = old;
    }
    return attributes;
  };
  if (typeof input.dryRun !== 'boolean' || !Array.isArray(input.items) || input.items.length > 100 || new Set(input.items.map(item => item.id)).size !== input.items.length) invalid('Invalid invoice item patch list.');
  const invoice = row(input.id, input.lastUpdate, input.headerPatch, input.previousHeader, INVOICE_HEADER_WRITE_FIELDS);
  if (input.items.length) invoice.polozkyDokladu = input.items.map(item => {
    checkKeys(item, ['id', 'lastUpdate', 'patch', 'previous']);
    return row(item.id, item.lastUpdate, item.patch, item.previous, INVOICE_ITEM_WRITE_FIELDS);
  });
  return { winstrom: { '@version': '1.0', 'faktura-prijata': [invoice] } };
}

function boundedInteger(value: unknown, min: number, max: number, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(message);
  return value;
}

function cloneSchema(result: SchemaResult): SchemaResult {
  return { evidence: result.evidence, properties: result.properties.map(property => ({ ...property, ...(property.values ? { values: property.values.map(value => ({ ...value })) } : {}) })) };
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
