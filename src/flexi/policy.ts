export type FieldKind = 'string' | 'integer' | 'decimal' | 'date' | 'datetime' | 'boolean' | 'reference' | 'yearMonth' | 'array';

const invoiceFields = {
  id: 'integer', kod: 'string', varSym: 'string', datVyst: 'date',
  datSplat: 'date', datZdan: 'date', sumZklCelkem: 'decimal',
  sumDphCelkem: 'decimal', sumCelkem: 'decimal', sumCelkemMen: 'decimal',
  stavUhrK: 'string', mena: 'string',
} as const;

/** Explicit MVP data policy; contact, bank, personnel and free text fields are absent. */
export const EVIDENCE_FIELDS: Readonly<Record<string, Readonly<Record<string, FieldKind>>>> = Object.freeze({
  'faktura-vydana': Object.freeze({ ...invoiceFields }),
  'faktura-prijata': Object.freeze({ ...invoiceFields }),
  adresar: Object.freeze({ id: 'integer', kod: 'string', nazev: 'string', ic: 'string', dic: 'string' }),
  cenik: Object.freeze({ id: 'integer', kod: 'string', nazev: 'string', cenaZakl: 'decimal', mena: 'string' }),
});

export type FilterOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
export interface FilterCondition { field: string; op: FilterOperator; value: string }

export class FlexiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FlexiError';
    this.code = code;
  }
}

export function invalid(message: string): never { throw new FlexiError('INVALID_INPUT', message); }

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some(key => !keys.includes(key))) invalid('Unsupported input fields.');
}

export function evidenceFields(evidence: string): Readonly<Record<string, FieldKind>> {
  if (typeof evidence !== 'string' || !Object.hasOwn(EVIDENCE_FIELDS, evidence)) invalid('Evidence is not permitted.');
  return EVIDENCE_FIELDS[evidence]!;
}

export function validateFields(evidence: string, fields: unknown, schema?: Readonly<Record<string, FieldKind>>): string[] {
  const allowed = schema ?? evidenceFields(evidence);
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > (schema ? 200 : 20) ||
      fields.some(field => typeof field !== 'string' || !Object.hasOwn(allowed, field)) ||
      new Set(fields).size !== fields.length) invalid('Select explicit permitted fields.');
  return [...fields] as string[];
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value);
}

/** Only fixed grammar tokens are emitted. No raw Flexi expressions are accepted. */
export function compileFilters(evidence: string, conditions: unknown, schema?: Readonly<Record<string, FieldKind>>): string | undefined {
  if (conditions === undefined) return undefined;
  if (!Array.isArray(conditions) || conditions.length > 10) invalid('At most ten filters are permitted.');
  const fields = schema ?? evidenceFields(evidence);
  const expressions = conditions.map((condition: unknown) => {
    checkKeys(condition, ['field', 'op', 'value']);
    const { field, op, value } = condition;
    if (typeof field !== 'string' || !Object.hasOwn(fields, field) ||
        typeof op !== 'string' || !['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains'].includes(op) ||
        typeof value !== 'string' || value.length < 1 || value.length > 200 ||
        /['"\\\p{C}]/u.test(value)) invalid('Invalid filter.');
    const kind = fields[field];
    if (kind === 'array') invalid('Array filters are not supported.');
    if (op === 'contains' && kind !== 'string') invalid('Contains requires a text field.');
    let literal: string;
    if (kind === 'integer') {
      if (!(schema ? /^-?(0|[1-9]\d{0,14})$/ : /^(0|[1-9]\d{0,14})$/).test(value)) invalid('Invalid integer filter.');
      literal = value;
    } else if (kind === 'decimal') {
      if (!/^-?(0|[1-9]\d{0,14})(\.\d{1,8})?$/.test(value)) invalid('Invalid decimal filter.');
      literal = value;
    } else if (kind === 'boolean') {
      if (!['true', 'false'].includes(value)) invalid('Invalid boolean filter.');
      literal = value;
    } else if (kind === 'yearMonth') {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) invalid('Invalid year-month filter.');
      literal = `'${value}'`;
    } else if (kind === 'datetime') {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?$/.test(value) || !validDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value + 'Z'))) invalid('Invalid datetime filter.');
      literal = value;
    } else if (kind === 'date') {
      if (!validDate(value)) invalid('Invalid date filter.');
      literal = value;
    } else {
      // URL/path separators are unnecessary for the MVP search vocabulary.
      if (/[/%?#()]/.test(value)) invalid('Unsupported filter characters.');
      literal = `'${value}'`;
    }
    return `${field} ${op === 'contains' ? 'like' : op} ${literal}`;
  });
  return expressions.length ? expressions.join(' and ') : undefined;
}

export function projectRecord(evidence: string, value: unknown, fields: readonly string[], schema?: Readonly<Record<string, FieldKind>>): Record<string, unknown> {
  if (!isObject(value)) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi response.');
  const output: Record<string, unknown> = {};
  const policy = schema ?? evidenceFields(evidence);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new FlexiError('INVALID_RESPONSE', 'Requested field is absent from the Flexi response.');
    const scalar = value[field];
    if (scalar === null) { output[field] = null; continue; }
    if (policy[field] === 'array' && Array.isArray(scalar)) {
      if (scalar.length > 1000 || scalar.some(item => !(item === null || (typeof item === 'string' && item.length <= 4096 && !/[\p{C}]/u.test(item)) || (typeof item === 'number' && Number.isSafeInteger(item)) || typeof item === 'boolean'))) throw new FlexiError('INVALID_RESPONSE', 'Invalid array in Flexi response.');
      output[field] = [...scalar];
      continue;
    }
    if (typeof scalar === 'string' && scalar.length <= (schema ? 65_536 : 4096) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(scalar)) {
      const kind = policy[field];
      if (kind === 'decimal' && scalar !== '' && !/^-?\d+(\.\d+)?$/.test(scalar)) throw new FlexiError('INVALID_RESPONSE', 'Invalid decimal in Flexi response.');
      if (kind === 'integer' && !(schema ? /^-?\d+$/ : /^\d+$/).test(scalar)) throw new FlexiError('INVALID_RESPONSE', 'Invalid integer in Flexi response.');
      if (kind === 'boolean' && !['true', 'false', ''].includes(scalar)) throw new FlexiError('INVALID_RESPONSE', 'Invalid boolean in Flexi response.');
      output[field] = scalar;
    } else if (policy[field] === 'boolean' && typeof scalar === 'boolean') {
      output[field] = scalar;
    } else if (policy[field] === 'integer' && typeof scalar === 'number' && Number.isSafeInteger(scalar) && (schema || scalar >= 0)) {
      output[field] = scalar;
    } else {
      // Money must remain an exact decimal string; references and nested payloads never pass through.
      throw new FlexiError('INVALID_RESPONSE', 'Invalid field type in Flexi response.');
    }
    if (schema && policy[field] === 'reference') {
      // Keep labels and internal IDs, never follow or emit upstream URLs.
      for (const suffix of ['@showAs', '@internalId']) {
        const companion = value[field + suffix];
        if (typeof companion === 'string' && companion.length <= 4096 && !/[\p{C}]/u.test(companion)) output[field + suffix] = companion;
        else if (suffix === '@internalId' && typeof companion === 'number' && Number.isSafeInteger(companion)) output[field + suffix] = companion;
      }
    }
  }
  return output;
}
