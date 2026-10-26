import { constants, openSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import * as z from 'zod';
import type { AppConfig, CompanyConfig } from './config.ts';
import { ConnectionRegistry } from './connections.ts';
import type { TargetHandle } from './connections.ts';
import { buildExistingInvoicePayload, INVOICE_HEADER_WRITE_FIELDS, INVOICE_ITEM_WRITE_FIELDS, FlexiError } from './flexi/client.ts';
import type { ExistingInvoiceUpdate, WriteScalar } from './flexi/client.ts';
import type { Property } from './flexi/metadata.ts';
import { isObject, projectRecord } from './flexi/policy.ts';
import { fieldPolicy } from './flexi/metadata.ts';
import { IntentStore, approvalPayload, canonicalJson, proposalDigest } from './write-store.ts';
import type { ApprovalEnvelope, IntentProposal, IntentState, WriteSnapshot } from './write-store.ts';

interface WritePolicy { enabled: boolean; headerFields: readonly string[]; itemFields: readonly string[] }
type WriteConfig = AppConfig & { writeStorePath?: string; writeApprovalPublicKeyPath?: string };
const numericId = z.string().regex(/^[1-9]\d{0,14}$/);
const patch = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/), z.union([z.string().max(4096), z.boolean()])).refine(value => Object.keys(value).length <= 40);
const ledgerFields = ['mdUcet', 'dalUcet', 'sumTuz', 'sumMen', 'typSzbDphK', 'szbDph', 'vatItem', 'zuctovano', 'clenDph'];
const headerGuards = ['sumOsv', 'sumZklSniz', 'sumZklSniz2', 'sumZklZakl', 'sumZklCelkem', 'sumDphSniz', 'sumDphSniz2', 'sumDphZakl', 'sumDphCelkem', 'sumCelkSniz', 'sumCelkSniz2', 'sumCelkZakl', 'sumCelkem', 'sumOsvMen', 'sumZklSnizMen', 'sumZklSniz2Men', 'sumZklZaklMen', 'sumZklCelkemMen', 'sumDphSnizMen', 'sumDphSniz2Men', 'sumDphZaklMen', 'sumDphCelkemMen', 'sumCelkSnizMen', 'sumCelkSniz2Men', 'sumCelkZaklMen', 'sumCelkemMen', 'mena', 'kurz', 'kurzMnozstvi', 'szbDphSniz', 'szbDphSniz2', 'szbDphZakl', 'clenDph', 'clenKonVykDph', 'primUcet', 'protiUcet', 'dphZaklUcet', 'dphSnizUcet', 'dphSniz2Ucet', 'typUcOp', 'ucetni'];
const itemGuards = ['mnozMj', 'cenaMj', 'sumZkl', 'sumDph', 'sumCelkem', 'sumZklMen', 'sumDphMen', 'sumCelkemMen', 'szbDph', 'typSzbDphK', 'typCenyDphK', 'mena', 'clenDph', 'clenKonVykDph', 'zklMdUcet', 'zklDalUcet', 'dphMdUcet', 'dphDalUcet', 'typUcOp', 'ucetni'];
const accountingSchema = z.strictObject({ rows: z.array(patch).min(1).max(100) }).refine(value => {
  const keys = Object.keys(value.rows[0]!).sort();
  return ['mdUcet', 'dalUcet', 'sumTuz', 'vatItem', 'clenDph', 'zuctovano'].every(key => keys.includes(key)) && keys.every(key => ledgerFields.includes(key)) && value.rows.every(row => canonicalJson(Object.keys(row).sort()) === canonicalJson(keys));
});
const inputSchema = z.strictObject({
  target: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/), invoiceId: numericId,
  expectedCode: z.string().min(1).max(128), headerPatch: patch.default({}),
  items: z.array(z.strictObject({ id: numericId, patch })).max(100).default([]),
  regenerateAccounting: z.boolean().default(false),
  accountingExpectation: accountingSchema.optional(),
});
export interface InvoiceWriteInput {
  target: string; invoiceId: string; expectedCode: string;
  headerPatch?: Record<string, WriteScalar>; items?: { id: string; patch: Record<string, WriteScalar> }[];
  regenerateAccounting?: boolean;
  accountingExpectation?: { rows: Record<string, WriteScalar>[] };
}
export interface IntentView {
  id: string; target: string; invoiceId: string; expectedCode: string; digest: string;
  status: IntentState['status'] | 'expired'; createdAt: string; expiresAt: string;
  approval: 'required' | 'valid' | 'invalid' | 'expired';
  approvalPayload: ReturnType<typeof approvalPayload>;
  guardedItemCount: number;
  dryRunDigest: string;
  dryRunChanges: IntentProposal['dryRun']['changes'];
  accountingVerification: 'not_requested' | 'required' | 'verified' | 'unknown';
  changes: { header: Record<string, { from: unknown; to: WriteScalar }>; items: { id: string; fields: Record<string, { from: unknown; to: WriteScalar }> }[] };
  code?: string; receipt?: Record<string, unknown>;
}

/** Existing-invoice writes need a separately signed local operator grant. */
export class InvoiceWriteService {
  readonly store: IntentStore;
  readonly #config: WriteConfig;
  readonly #registry: ConnectionRegistry;
  readonly #publicKey: KeyObject;
  readonly #now: () => number;
  readonly #active = new Set<string>();

  constructor(config: AppConfig, registry: ConnectionRegistry, options: { now?: () => number; store?: IntentStore } = {}) {
    this.#config = config as WriteConfig; this.#registry = registry; this.#now = options.now ?? Date.now;
    if (!this.#config.writeStorePath || !this.#config.writeApprovalPublicKeyPath) throw new FlexiError('WRITE_NOT_CONFIGURED', 'Write store and operator public key must be configured.');
    this.store = options.store ?? new IntentStore(this.#config.writeStorePath);
    let file: number | undefined;
    try {
      file = openSync(this.#config.writeApprovalPublicKeyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.size > 16_384) throw new Error('key');
      this.#publicKey = createPublicKey(readFileSync(file));
      if (this.#publicKey.asymmetricKeyType !== 'ed25519') throw new Error('key');
    } catch { throw new FlexiError('APPROVAL_INVALID', 'Invalid operator approval public key.'); }
    finally { if (file !== undefined) closeSync(file); }
  }

  async prepare(raw: InvoiceWriteInput): Promise<IntentView> {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success || Buffer.byteLength(canonicalJson(raw)) > 65_536) throw new FlexiError('INVALID_INPUT', 'Invalid or oversized invoice update proposal.');
    const input = parsed.data;
    if (input.regenerateAccounting && !input.accountingExpectation) throw new FlexiError('ACCOUNTING_EXPECTATION_REQUIRED', 'On-save accounting verification requires explicit expected journal rows; no separate regeneration action is sent.');
    if (!Object.keys(input.headerPatch).length && !input.items.length) throw new FlexiError('INVALID_INPUT', 'Select at least one existing field to update.');
    if (new Set(input.items.map(item => item.id)).size !== input.items.length || input.items.some(item => !Object.keys(item.patch).length)) throw new FlexiError('INVALID_INPUT', 'Invoice item patches must be nonempty and unique.');
    const handle = this.#registry.resolve(input.target);
    const policy = this.#policy(handle);
    const documentKey = this.#documentKey(handle, input.invoiceId);
    return this.store.withDocumentLock(documentKey, async () => {
      await this.#checkDocumentFence(documentKey);
      await this.#registry.ensureReady(handle);
      const properties = await this.#validatePatches(handle, policy, input.headerPatch, input.items);
      await this.#validateAccounting(handle, input.accountingExpectation);
      const snapshot = await this.#snapshot(handle, input.invoiceId, input.expectedCode, input.headerPatch, input.items, input.accountingExpectation);
      for (const item of input.items) if (!snapshot.items.some(existing => existing.id === item.id)) throw new FlexiError('ITEM_NOT_FOUND', 'An item does not belong to the selected invoice.');
      const native = this.#native(input.invoiceId, input.headerPatch, input.items, snapshot, true);
      const dryRunResult = await handle.client.updateExistingInvoice(native);
      importResult(dryRunResult, input.invoiceId);
      const dryRun = this.#dryRun(dryRunResult, snapshot, properties);
      this.#verify({ snapshot, headerPatch: input.headerPatch, items: input.items }, { invoice: dryRun.expected.invoice, items: dryRun.expected.items, membership: snapshot.membership }, properties);
      const proposalBody: Omit<IntentProposal, 'digest'> = {
        version: 1, id: randomUUID(), target: handle.target, serverId: handle.serverId, database: handle.database, routingRevision: handle.revision,
        invoiceId: input.invoiceId, expectedCode: input.expectedCode, createdAt: new Date(this.#now()).toISOString(), expiresAt: new Date(this.#now() + 1_800_000).toISOString(),
        policyDigest: digest(policy), headerPatch: input.headerPatch, items: input.items, snapshot, payload: buildExistingInvoicePayload(native), dryRun,
        ...(input.accountingExpectation ? { accountingExpectation: input.accountingExpectation } : {}),
      };
      const proposal: IntentProposal = { ...proposalBody, digest: proposalDigest(proposalBody) };
      if (Buffer.byteLength(canonicalJson(proposal)) > 1_000_000) throw new FlexiError('WRITE_TOO_LARGE', 'The invoice update snapshot exceeds its bounded size limit.');
      await this.store.create(proposal);
      return this.#view(proposal, await this.store.readState(proposal.id));
    });
  }

  async status(target: string, id: string): Promise<IntentView> {
    const handle = this.#registry.resolve(target);
    const proposal = await this.store.get(id);
    this.#matchTarget(target, proposal);
    this.#matchRouting(handle, proposal);
    return this.#view(proposal, await this.store.readState(id));
  }

  async commit(target: string, id: string): Promise<IntentView> {
    let dispatched = false;
    const handle = this.#registry.resolve(target);
    const initial = await this.store.get(id);
    this.#matchTarget(target, initial);
    this.#matchRouting(handle, initial);
    const initialState = await this.store.readState(id);
    // A persisted attempt is never replayed, including after a process restart.
    if (initialState.status !== 'prepared') return this.#view(initial, initialState);
    try { return await this.store.withIntentLock(id, async () => this.store.withDocumentLock(this.#documentKey(handle, initial.invoiceId), async () => {
      const proposal = await this.store.get(id);
      this.#matchTarget(target, proposal);
      this.#matchRouting(handle, proposal);
      let state = await this.store.readState(id);
      if (state.status !== 'prepared') return this.#view(proposal, state);
      const documentKey = this.#documentKey(handle, proposal.invoiceId);
      await this.#checkDocumentFence(documentKey);
      const policy = this.#policy(handle);
      if (proposal.routingRevision !== handle.revision || proposal.database !== handle.database || proposal.serverId !== handle.serverId || proposal.policyDigest !== digest(policy)) throw new FlexiError('INTENT_SCOPE_CHANGED', 'Target routing or write policy changed; prepare a new intent.');
      if (Date.parse(proposal.expiresAt) <= this.#now()) throw new FlexiError('INTENT_EXPIRED', 'The prepared invoice update has expired.');
      this.#checkApproval(proposal, await this.store.readApproval(id));
      await this.#registry.ensureReady(handle);
      const types = await this.#validatePatches(handle, policy, proposal.headerPatch, proposal.items);
      const ledgerTypes = await this.#validateAccounting(handle, proposal.accountingExpectation);
      const fresh = await this.#snapshot(handle, proposal.invoiceId, proposal.expectedCode, proposal.headerPatch, proposal.items, proposal.accountingExpectation);
      if (canonicalJson(fresh) !== canonicalJson(proposal.snapshot)) {
        state = { status: 'conflict', code: 'SNAPSHOT_CHANGED', updatedAt: new Date(this.#now()).toISOString() };
        await this.store.writeState(id, state); return this.#view(proposal, state);
      }
      const native = this.#native(proposal.invoiceId, proposal.headerPatch, proposal.items, fresh, false);
      if (canonicalJson(buildExistingInvoicePayload(native)) !== canonicalJson(proposal.payload)) throw new FlexiError('WRITE_STORE_INVALID', 'The exact approved update payload changed.');
      // Preflight reads may have consumed the remaining approval lifetime.
      this.#checkApproval(proposal, await this.store.readApproval(id));
      await this.store.putDocumentFence(documentKey, { intentId: id, target: proposal.target, digest: proposal.digest, createdAt: new Date(this.#now()).toISOString() });
      // This fsync must complete BEFORE the first mutating request.
      state = { status: 'committing', updatedAt: new Date(this.#now()).toISOString() };
      await this.store.writeState(id, state);
      this.#checkApproval(proposal, await this.store.readApproval(id));
      this.#active.add(id);
      dispatched = true;
      try {
        const stats = importResult(await handle.client.updateExistingInvoice(native), proposal.invoiceId);
        const after = await this.#snapshot(handle, proposal.invoiceId, proposal.expectedCode, proposal.headerPatch, proposal.items, proposal.accountingExpectation);
        this.#verify(proposal, after, types);
        this.#verifyDryRun(proposal, after, types);
        if (proposal.accountingExpectation && !matchesLedger(proposal.accountingExpectation.rows, after.ledger ?? [], ledgerTypes)) throw new FlexiError('ACCOUNTING_VERIFICATION_FAILED', 'The actual journal does not match the approved accounting expectation.');
        state = { status: 'succeeded', updatedAt: new Date(this.#now()).toISOString(), receipt: { target: proposal.target, invoiceId: proposal.invoiceId, digest: proposal.digest, verifiedAt: new Date(this.#now()).toISOString(), stats, lastUpdate: after.invoice.lastUpdate } };
      } catch (error) {
        const code = error instanceof FlexiError ? error.code : 'WRITE_UNKNOWN';
        state = { status: code === 'WRITE_CONFLICT' ? 'conflict' : code === 'WRITE_REJECTED' ? 'rejected' : 'unknown', code, updatedAt: new Date(this.#now()).toISOString() };
      } finally { this.#active.delete(id); }
      // A failure here leaves the durable 'committing' marker: subsequent calls report unknown.
      await this.store.writeState(id, state);
      return this.#view(proposal, state);
    })); } catch (error) {
      if (dispatched) throw new FlexiError('WRITE_UNKNOWN', `The invoice write outcome requires inspection of intent ${id}; do not retry the mutation.`);
      throw error;
    }
  }

  async #validateAccounting(handle: TargetHandle, expectation: IntentProposal['accountingExpectation']): Promise<Property[]> {
    if (!expectation) return [];
    const properties = (await handle.client.schema('ucetni-denik', true)).properties;
    for (const row of expectation.rows) {
      for (const [field, value] of Object.entries(row)) {
        const property = properties.find(property => property.name === field);
        if (!ledgerFields.includes(field) || !property) throw new FlexiError('ACCOUNTING_EXPECTATION_INVALID', 'An expected journal field is not available.');
        validateValue(property, value);
      }
    }
    return properties;
  }

  #policy(handle: TargetHandle): WritePolicy {
    const company = this.#config.servers?.find(server => server.id === handle.serverId)?.companies.find(company => company.id === handle.companyId) as (CompanyConfig & { writePolicy?: WritePolicy }) | undefined;
    const policy = company?.writePolicy;
    if (!policy?.enabled) throw new FlexiError('WRITE_DISABLED', 'Invoice updates are disabled for this target.');
    if (!handle.client.allRead) throw new FlexiError('WRITE_SCHEMA_REQUIRED', 'Invoice updates require runtime-schema read access.');
    return { enabled: true, headerFields: [...policy.headerFields], itemFields: [...policy.itemFields] };
  }

  async #validatePatches(handle: TargetHandle, policy: WritePolicy, header: Record<string, WriteScalar>, items: { id: string; patch: Record<string, WriteScalar> }[]): Promise<{ header: Property[]; items: Property[] }> {
    const headerSchema = (await handle.client.schema('faktura-prijata', true)).properties;
    const itemSchema = (await handle.client.schema('faktura-prijata-polozka', true)).properties;
    const validate = (patch: Record<string, WriteScalar>, configured: readonly string[], fixed: readonly string[], properties: Property[]) => {
      for (const [field, value] of Object.entries(patch)) {
        const property = properties.find(property => property.name === field);
        if (!fixed.includes(field) || !configured.includes(field) || !property?.writable) throw new FlexiError('WRITE_FIELD_DENIED', 'A patch field is outside the configured writable invoice schema.');
        validateValue(property, value);
      }
    };
    validate(header, policy.headerFields, INVOICE_HEADER_WRITE_FIELDS, headerSchema);
    for (const item of items) validate(item.patch, policy.itemFields, INVOICE_ITEM_WRITE_FIELDS, itemSchema);
    return { header: headerSchema, items: itemSchema };
  }

  async #snapshot(handle: TargetHandle, id: string, expectedCode: string, headerPatch: Record<string, WriteScalar>, itemPatches: { id: string; patch: Record<string, WriteScalar> }[], expectation?: IntentProposal['accountingExpectation']): Promise<WriteSnapshot> {
    const headerSchema = (await handle.client.schema('faktura-prijata')).properties;
    const itemSchema = (await handle.client.schema('faktura-prijata-polozka')).properties;
    const headerFields = [...new Set(['id', 'kod', 'lastUpdate', ...Object.keys(headerPatch), ...headerGuards.filter(field => headerSchema.some(property => property.name === field))])];
    const header = await handle.client.getRecord({ evidence: 'faktura-prijata', id, fields: headerFields });
    const invoice = header.records[0];
    if (!invoice || String(invoice.id) !== id || invoice.kod !== expectedCode || typeof invoice.lastUpdate !== 'string') throw new FlexiError('INVOICE_IDENTITY_MISMATCH', 'The exact invoice ID, code or version does not match.');
    const relations = await handle.client.relations('faktura-prijata');
    if (!relations.some(relation => relation.name === 'polozkyDokladu' && relation.evidence === 'faktura-prijata-polozka')) throw new FlexiError('WRITE_SCHEMA_REQUIRED', 'The invoice item relation is not available.');
    const fields = [...new Set(['id', 'lastUpdate', 'doklFak', ...itemPatches.flatMap(item => Object.keys(item.patch)), ...itemGuards.filter(field => itemSchema.some(property => property.name === field))])];
    const records: Record<string, unknown>[] = [];
    let start = 0;
    while (true) {
      const page = await handle.client.listRelation({ evidence: 'faktura-prijata', id, relation: 'polozkyDokladu', fields, start, limit: 100 });
      records.push(...page.records);
      if (records.length > 100) throw new FlexiError('WRITE_TOO_LARGE', 'At most 100 existing invoice items can be protected by one update intent.');
      if (page.rowCount !== undefined && records.length >= page.rowCount) break;
      if (page.records.length < 100) {
        if (page.rowCount !== undefined && records.length < page.rowCount) throw new FlexiError('INVALID_RESPONSE', 'Incomplete invoice item membership response.');
        break;
      }
      start += page.records.length;
      if (start > 10_000) throw new FlexiError('WRITE_TOO_LARGE', 'Invoice item discovery exceeded its pagination limit.');
    }
    const ids = new Set<string>();
    const sorted = records.map(record => {
      const itemId = String(record.id);
      if (!/^[1-9]\d{0,14}$/.test(itemId) || ids.has(itemId) || typeof record.lastUpdate !== 'string') throw new FlexiError('INVALID_RESPONSE', 'Invalid or duplicate invoice item identity.');
      ids.add(itemId);
      const parentId = record['doklFak@internalId'];
      if (parentId !== undefined ? String(parentId) !== id : String(record.doklFak) !== id && record.doklFak !== `code:${expectedCode}`) throw new FlexiError('ITEM_PARENT_MISMATCH', 'An item belongs to a different invoice.');
      return { id: itemId, record };
    }).sort((a, b) => Number(a.id) - Number(b.id));
    const snapshot: WriteSnapshot = { invoice, items: sorted, membership: sorted.map(item => ({ id: item.id, lastUpdate: String(item.record.lastUpdate) })) };
    if (expectation) {
      const ledger: Record<string, unknown>[] = [];
      let offset = 0;
      while (true) {
        const page = await handle.client.listRecords({ evidence: 'ucetni-denik', fields: Object.keys(expectation.rows[0]!), filters: [{ field: 'idDokl', op: 'eq', value: id }, { field: 'modulK', op: 'eq', value: 'modulUcetni.FAP' }], limit: 100, start: offset });
        ledger.push(...page.records);
        if (ledger.length > 100) throw new FlexiError('WRITE_TOO_LARGE', 'The invoice journal exceeds the bounded verification limit.');
        if (page.rowCount !== undefined && ledger.length >= page.rowCount) break;
        if (page.records.length < 100) {
          if (page.rowCount !== undefined && ledger.length < page.rowCount) throw new FlexiError('INVALID_RESPONSE', 'Incomplete journal response.');
          break;
        }
        offset += page.records.length;
      }
      snapshot.ledger = ledger.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    }
    return snapshot;
  }

  #native(id: string, headerPatch: Record<string, WriteScalar>, itemPatches: { id: string; patch: Record<string, WriteScalar> }[], snapshot: WriteSnapshot, dryRun: boolean): ExistingInvoiceUpdate {
    return { id, lastUpdate: String(snapshot.invoice.lastUpdate), headerPatch, previousHeader: snapshot.invoice,
      items: snapshot.items.map(item => ({ id: item.id, lastUpdate: String(item.record.lastUpdate), patch: itemPatches.find(patch => patch.id === item.id)?.patch ?? {}, previous: item.record })), dryRun };
  }

  #verify(proposal: Pick<IntentProposal, 'snapshot' | 'headerPatch' | 'items'>, after: WriteSnapshot, types: { header: Property[]; items: Property[] }): void {
    if (canonicalJson(after.membership.map(item => item.id)) !== canonicalJson(proposal.snapshot.membership.map(item => item.id))) throw new FlexiError('WRITE_VERIFICATION_FAILED', 'Invoice item membership changed after update.');
    const check = (patch: Record<string, WriteScalar>, record: Record<string, unknown>, properties: Property[]) => {
      for (const [field, expected] of Object.entries(patch)) if (!matchesValue(properties.find(property => property.name === field)!, expected, record[field], record[`${field}@internalId`])) throw new FlexiError('WRITE_VERIFICATION_FAILED', 'An approved field value did not verify after update.');
    };
    check(proposal.headerPatch, after.invoice, types.header);
    for (const patch of proposal.items) {
      const item = after.items.find(item => item.id === patch.id);
      if (!item) throw new FlexiError('WRITE_VERIFICATION_FAILED', 'An updated invoice item is missing.');
      check(patch.patch, item.record, types.items);
    }
  }

  #dryRun(payload: unknown, snapshot: WriteSnapshot, types: { header: Property[]; items: Property[] }): IntentProposal['dryRun'] {
    const body = isObject(payload) && isObject(payload.winstrom) ? payload.winstrom : undefined;
    const result = Array.isArray(body?.results) ? body.results.find(result => isObject(result) && String(result.id) === String(snapshot.invoice.id)) : undefined;
    const container = isObject(result) && isObject(result.content) ? result.content : undefined;
    const content = container && isObject(container['faktura-prijata']) ? container['faktura-prijata'] : container && typeof container.id !== 'undefined' ? container : undefined;
    if (!content) throw new FlexiError('DRY_RUN_CONTENT_REQUIRED', 'Dry-run calculated invoice content is required before approval.');
    const project = (record: unknown, baseline: Record<string, unknown>, properties: Property[]) => {
      const fields = Object.keys(baseline).filter(field => !field.includes('@') && field !== 'lastUpdate');
      const values = projectRecord('faktura-prijata', record, fields, fieldPolicy(properties));
      return Object.fromEntries(fields.map(field => [field, values[field]]));
    };
    const invoice = project(content, snapshot.invoice, types.header);
    if (String(invoice.id) !== String(snapshot.invoice.id) || invoice.kod !== snapshot.invoice.kod) throw new FlexiError('DRY_RUN_CONTENT_INVALID', 'Dry-run invoice identity changed.');
    if (content.polozkyFaktury !== undefined && content.polozkyDokladu !== undefined) throw new FlexiError('DRY_RUN_CONTENT_INVALID', 'Ambiguous calculated invoice item collections.');
    const childRows = content.polozkyFaktury ?? content.polozkyDokladu ?? [];
    if (!Array.isArray(childRows) || childRows.length !== snapshot.items.length) throw new FlexiError('DRY_RUN_CONTENT_INVALID', 'Dry-run item membership is incomplete or changed.');
    const items = snapshot.items.map(item => {
      const matches = childRows.filter(row => isObject(row) && String(row.id) === item.id);
      if (matches.length !== 1) throw new FlexiError('DRY_RUN_CONTENT_INVALID', 'Dry-run item identities changed.');
      return { id: item.id, record: project(matches[0], item.record, types.items) };
    });
    const expected = { invoice, items };
    const diff = (before: Record<string, unknown>, after: Record<string, unknown>, properties: Property[]) => Object.fromEntries(Object.entries(after).filter(([field, value]) => !matchesValue(properties.find(property => property.name === field)!, value, before[field], before[`${field}@internalId`])).map(([field, value]) => [field, { from: before[field], to: value }]));
    return { digest: digest(expected), expected, changes: { header: diff(snapshot.invoice, invoice, types.header), items: items.map(item => ({ id: item.id, fields: diff(snapshot.items.find(before => before.id === item.id)!.record, item.record, types.items) })).filter(item => Object.keys(item.fields).length > 0) } };
  }

  #verifyDryRun(proposal: IntentProposal, after: WriteSnapshot, types: { header: Property[]; items: Property[] }): void {
    if (proposal.dryRun.digest !== digest(proposal.dryRun.expected)) throw new FlexiError('WRITE_STORE_INVALID', 'The approved calculated result changed.');
    const check = (expected: Record<string, unknown>, actual: Record<string, unknown>, properties: Property[]) => {
      for (const [field, value] of Object.entries(expected)) {
        const property = properties.find(property => property.name === field);
        if (!property || !matchesValue(property, value, actual[field], actual[`${field}@internalId`])) throw new FlexiError('DRY_RUN_VERIFICATION_FAILED', 'The saved invoice differs from the approved calculated dry-run result.');
      }
    };
    check(proposal.dryRun.expected.invoice, after.invoice, types.header);
    for (const expected of proposal.dryRun.expected.items) {
      const actual = after.items.find(item => item.id === expected.id);
      if (!actual) throw new FlexiError('DRY_RUN_VERIFICATION_FAILED', 'An approved calculated item is missing.');
      check(expected.record, actual.record, types.items);
    }
  }

  async #checkDocumentFence(key: string): Promise<void> {
    const fence = await this.store.getDocumentFence(key);
    if (!fence) return;
    try {
      const intent = await this.store.get(fence.intentId);
      const state = await this.store.readState(fence.intentId);
      if (intent.target === fence.target && intent.digest === fence.digest && ['succeeded', 'conflict', 'rejected'].includes(state.status)) return;
    } catch { /* Missing or invalid history also requires explicit reconciliation. */ }
    throw new FlexiError('DOCUMENT_RECONCILIATION_REQUIRED', `Inspect prior intent ${fence.intentId} before another update to this document.`);
  }

  #checkApproval(proposal: IntentProposal, envelope: ApprovalEnvelope | undefined): void {
    if (!envelope) throw new FlexiError('APPROVAL_REQUIRED', 'A local operator must sign this exact prepared intent.');
    if (canonicalJson(envelope.payload) !== canonicalJson(approvalPayload(proposal)) || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) throw new FlexiError('APPROVAL_INVALID', 'Operator approval does not match this intent.');
    const signature = Buffer.from(envelope.signature, 'base64');
    if (signature.length !== 64 || !verify(null, Buffer.from(canonicalJson(envelope.payload)), this.#publicKey, signature)) throw new FlexiError('APPROVAL_INVALID', 'Invalid operator approval signature.');
    if (Date.parse(envelope.payload.expiresAt) <= this.#now()) throw new FlexiError('INTENT_EXPIRED', 'Operator approval has expired.');
  }
  #matchTarget(target: string, intent: IntentProposal): void { if (intent.target !== target) throw new FlexiError('INTENT_TARGET_MISMATCH', 'The intent belongs to a different target.'); }
  #matchRouting(handle: TargetHandle, intent: IntentProposal): void {
    if (intent.routingRevision !== handle.revision || intent.database !== handle.database || intent.serverId !== handle.serverId) throw new FlexiError('INTENT_SCOPE_CHANGED', 'The intent belongs to a different target routing revision.');
  }
  #documentKey(handle: TargetHandle, id: string): string { return canonicalJson({ origin: this.#registry.servers().find(server => server.serverId === handle.serverId)!.baseUrl, database: handle.database, invoiceId: id }); }

  async #view(proposal: IntentProposal, state: IntentState): Promise<IntentView> {
    let approval: IntentView['approval'] = 'required';
    const expired = Date.parse(proposal.expiresAt) <= this.#now();
    try { const grant = await this.store.readApproval(proposal.id); if (grant) { this.#checkApproval(proposal, grant); approval = 'valid'; } }
    catch { approval = expired ? 'expired' : 'invalid'; }
    const change = (patch: Record<string, WriteScalar>, baseline: Record<string, unknown>) => Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, { from: baseline[field], to: value }]));
    const fence = state.status === 'prepared' ? await this.store.getDocumentFence(this.#documentKey(this.#registry.resolve(proposal.target), proposal.invoiceId)) : undefined;
    const fencedPrepared = fence?.intentId === proposal.id;
    return { id: proposal.id, target: proposal.target, invoiceId: proposal.invoiceId, expectedCode: proposal.expectedCode, digest: proposal.digest,
      status: fencedPrepared || state.status === 'committing' && !this.#active.has(proposal.id) ? 'unknown' : state.status === 'prepared' && expired ? 'expired' : state.status,
      createdAt: proposal.createdAt, expiresAt: proposal.expiresAt, approval, approvalPayload: approvalPayload(proposal), guardedItemCount: proposal.snapshot.items.length,
      dryRunDigest: proposal.dryRun.digest, dryRunChanges: proposal.dryRun.changes,
      accountingVerification: !proposal.accountingExpectation ? 'not_requested' : state.status === 'succeeded' ? 'verified' : state.status === 'unknown' || state.status === 'committing' ? 'unknown' : 'required',
      changes: { header: change(proposal.headerPatch, proposal.snapshot.invoice), items: proposal.items.map(item => ({ id: item.id, fields: change(item.patch, proposal.snapshot.items.find(existing => existing.id === item.id)!.record) })) },
      ...(state.code ? { code: state.code } : {}), ...(state.receipt ? { receipt: state.receipt } : {}),
    };
  }
}

function digest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function validateValue(property: Property, value: WriteScalar): void {
  if (typeof value === 'string' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new FlexiError('INVALID_INPUT', 'Invalid patch value.');
  const text = String(value);
  if (property.type === 'boolean') { if (!(typeof value === 'boolean' || ['true', 'false'].includes(text))) throw new FlexiError('INVALID_INPUT', 'Invalid boolean patch value.'); return; }
  if (typeof value !== 'string') throw new FlexiError('INVALID_INPUT', 'This field requires a string patch value.');
  if (property.type === 'decimal' && !/^-?(0|[1-9]\d{0,14})(\.\d{1,8})?$/.test(text)) throw new FlexiError('INVALID_INPUT', 'Invalid exact decimal patch value.');
  if (property.type === 'integer' && !/^-?(0|[1-9]\d{0,14})$/.test(text)) throw new FlexiError('INVALID_INPUT', 'Invalid integer patch value.');
  if (property.type === 'reference' && !/^(?:[1-9]\d{0,14}|code:[^\p{C}]{1,200})$/u.test(text)) throw new FlexiError('INVALID_INPUT', 'Use an existing reference ID or code.');
  if (property.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 10) !== text)) throw new FlexiError('INVALID_INPUT', 'Invalid date patch value.');
  if (property.values?.length && !property.values.some(option => option.value === text)) throw new FlexiError('INVALID_INPUT', 'Patch value is outside the schema enum.');
}
function matchesValue(property: Property, expected: unknown, actual: unknown, internalId?: unknown): boolean {
  if (expected === null) return actual === null;
  if (property.type === 'boolean') return String(expected) === String(actual);
  if (property.type === 'integer') return String(expected) === String(actual);
  if (property.type === 'decimal') return typeof actual === 'string' && decimal(String(expected)) === decimal(actual);
  if (property.type === 'reference' && /^[1-9]\d*$/.test(String(expected))) return String(expected) === String(internalId ?? actual);
  if (property.type === 'date') return typeof actual === 'string' && String(expected) === actual.slice(0, 10);
  return expected === actual;
}
function decimal(value: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return '!invalid';
  let [whole, fraction = ''] = value.split('.');
  const negative = whole!.startsWith('-'); whole = whole!.replace(/^-/, '').replace(/^0+(?=\d)/, ''); fraction = fraction.replace(/0+$/, '');
  return (negative && (whole !== '0' || fraction) ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}
function importResult(payload: unknown, invoiceId: string): { created: number; updated: number; deleted: number } {
  const body = isObject(payload) && isObject(payload.winstrom) ? payload.winstrom : undefined;
  if (!body) throw new FlexiError('WRITE_UNKNOWN', 'The update response is not a verified import result.');
  if (body.success === false || body.success === 'false') throw new FlexiError('WRITE_REJECTED', 'Flexi rejected the atomic update.');
  if (hasIssues(body)) throw new FlexiError('WRITE_UNKNOWN', 'The update result contains errors or warnings without a verified rollback.');
  if (!(body.success === true || body.success === 'true') || !isObject(body.stats)) throw new FlexiError('WRITE_UNKNOWN', 'The update response lacks a verified success receipt.');
  const rawStats = body.stats;
  const stats = Object.fromEntries(['created', 'updated', 'deleted', 'skipped', 'failed'].map(key => {
    const raw = rawStats[key];
    if (!(typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw))) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 0) throw new FlexiError('WRITE_UNKNOWN', 'Invalid import result statistics.');
    return [key, Number(raw)];
  })) as { created: number; updated: number; deleted: number; skipped: number; failed: number };
  if (stats.created !== 0 || stats.deleted !== 0) throw new FlexiError('WRITE_UNKNOWN', 'Unexpected create or delete reported by update-only import.');
  if (stats.skipped !== 0 || stats.failed !== 0 || stats.updated < 1 || !Array.isArray(body.results) || !body.results.some(result => isObject(result) && String(result.id) === invoiceId)) throw new FlexiError('WRITE_UNKNOWN', 'The import result does not confirm the existing target invoice update.');
  return { created: stats.created, updated: stats.updated, deleted: stats.deleted };
}

function matchesLedger(expected: Record<string, WriteScalar>[], actual: Record<string, unknown>[], properties: Property[]): boolean {
  if (expected.length !== actual.length) return false;
  const edges = expected.map(row => actual.map(candidate => Object.entries(row).every(([field, value]) => matchesValue(properties.find(property => property.name === field)!, value, candidate[field], candidate[`${field}@internalId`]))));
  const matched = new Array<number>(actual.length).fill(-1);
  const assign = (row: number, seen: boolean[]): boolean => {
    for (let column = 0; column < actual.length; column++) {
      if (seen[column] || !edges[row]?.[column]) continue;
      seen[column] = true;
      if (matched[column] === -1 || assign(matched[column]!, seen)) { matched[column] = row; return true; }
    }
    return false;
  };
  return expected.every((_row, index) => assign(index, new Array<boolean>(actual.length).fill(false)));
}
function hasIssues(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some(item => hasIssues(item, depth + 1));
  if (!isObject(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:errors?|warnings?)$/.test(key) && ((Array.isArray(item) && item.length > 0) || (typeof item === 'string' && item.length > 0) || (isObject(item) && Object.keys(item).length > 0) || (typeof item === 'number' && item > 0))) return true;
    if (hasIssues(item, depth + 1)) return true;
  }
  return false;
}
