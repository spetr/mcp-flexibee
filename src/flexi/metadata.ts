import { FlexiError, invalid, isObject } from './policy.ts';
import type { FieldKind } from './policy.ts';

export interface Evidence { evidence: string; name: string; evidenceType: string; access: boolean; importStatus: string; blockedReason?: string }
export interface Property { name: string; type: FieldKind; label?: string; referenceEvidence?: string; primaryKey?: boolean; writable?: true; values?: { value: string; label: string }[] }
export interface Relation { name: string; label: string; evidence: string }
const segment = /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;
const forbidden = new Set(['uzivatel', 'certifikat', 'certifikat-finbricks', 'certifikacni-autorita', 'def-store', 'setting-store', 'global-store', 'integrace', 'doplnek', 'objekt-doplnku', 'automatizace', 'automatizace-typ', 'custom-button', 'xslt']);
const types: Readonly<Record<string, FieldKind>> = { string: 'string', select: 'string', integer: 'integer', numeric: 'decimal', decimal: 'decimal', date: 'date', datetime: 'datetime', logic: 'boolean', boolean: 'boolean', relation: 'reference', yearMonth: 'yearMonth', array: 'array' };
export function validSegment(value: unknown): value is string { return typeof value === 'string' && segment.test(value); }
export function assertSegment(value: unknown): asserts value is string { if (!validSegment(value)) invalid('Invalid evidence, relation or field identifier.'); }
export function permittedEvidence(value: string): boolean { return validSegment(value) && !forbidden.has(value); }
export function permittedProperty(value: string): boolean {
  return validSegment(value) && !/password|passwd|heslo|token|secret|privatekey|soukromyklic|authsession|credential|certifikat|^obsah$|^content$|^data$/i.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
}
function rows(payload: unknown, root: string, key: string, max: number): unknown[] {
  const container = isObject(payload) ? payload[root] : undefined;
  const values = isObject(container) ? container[key] : undefined;
  if (isObject(container) && values == null) return [];
  if (!Array.isArray(values) || values.length > max) throw new FlexiError('INVALID_RESPONSE', 'Invalid Flexi metadata envelope.');
  return values;
}
function text(value: unknown, fallback = ''): string { return typeof value === 'string' && value.length <= 512 && !/[\p{C}]/u.test(value) ? value : fallback; }
export function parseEvidences(payload: unknown): Evidence[] {
  const seen = new Set<string>();
  return rows(payload, 'evidences', 'evidence', 2000).map(value => {
    if (!isObject(value) || !validSegment(value.evidencePath) || seen.has(value.evidencePath)) throw new FlexiError('INVALID_RESPONSE', 'Invalid or duplicate Flexi evidence.');
    seen.add(value.evidencePath);
    const blockedReason = permittedEvidence(value.evidencePath) ? undefined : 'credential_or_executable_configuration';
    return { evidence: value.evidencePath, name: text(value.evidenceName), evidenceType: text(value.evidenceType), access: (value.evidenceAccess === 'true' || value.evidenceAccess === true) && !blockedReason, importStatus: text(value.importStatus), ...(blockedReason ? { blockedReason } : {}) };
  });
}
export function parseProperties(payload: unknown): Property[] {
  const seen = new Set<string>();
  const result: Property[] = [];
  for (const value of rows(payload, 'properties', 'property', 2000)) {
    if (!isObject(value) || !validSegment(value.propertyName) || seen.has(value.propertyName)) throw new FlexiError('INVALID_RESPONSE', 'Invalid or duplicate Flexi property.');
    seen.add(value.propertyName);
    const type = typeof value.type === 'string' && Object.hasOwn(types, value.type) ? types[value.type] : undefined;
    if (!type || !permittedProperty(value.propertyName)) continue;
    const options = isObject(value.values) && Array.isArray(value.values.value) ? value.values.value : [];
    if (options.length > 500) throw new FlexiError('INVALID_RESPONSE', 'Too many enum values in Flexi metadata.');
    const values = options.flatMap(option => isObject(option) && text(option['@key']) ? [{ value: text(option['@key']), label: text(option.$) }] : []);
    result.push({ name: value.propertyName, type, label: text(value.title, text(value.name)), ...(value.isWritable === 'true' || value.isWritable === true ? { writable: true } : {}), ...(value.inId === 'true' || value.inId === true ? { primaryKey: true } : {}), ...(type === 'reference' && validSegment(value.fkEvidencePath) ? { referenceEvidence: value.fkEvidencePath } : {}), ...(values.length ? { values } : {}) });
  }
  if (!result.length) throw new FlexiError('INVALID_RESPONSE', 'No readable Flexi properties.');
  return result;
}
export function parseRelations(payload: unknown, evidences: Evidence[]): Relation[] {
  const seen = new Set<string>();
  return rows(payload, 'relations', 'relation', 500).flatMap(value => {
    if (!isObject(value) || !validSegment(value.url) || seen.has(value.url)) throw new FlexiError('INVALID_RESPONSE', 'Invalid or duplicate Flexi relation.');
    seen.add(value.url);
    const candidates = evidences.filter(e => e.evidenceType === value.evidenceType && e.access);
    if (candidates.length !== 1) return [];
    return [{ name: value.url, label: text(value.name), evidence: candidates[0]!.evidence }];
  });
}
export function fieldPolicy(properties: readonly Property[]): Readonly<Record<string, FieldKind>> {
  return Object.fromEntries(properties.map(p => [p.name, p.type]));
}
