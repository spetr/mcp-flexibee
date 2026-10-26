import { constants } from 'node:fs';
import { mkdir, open, lstat, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { FlexiError, isObject } from './flexi/policy.ts';
import type { WriteScalar } from './flexi/client.ts';

export interface WriteSnapshot {
  invoice: Record<string, unknown>;
  items: { id: string; record: Record<string, unknown> }[];
  membership: { id: string; lastUpdate: string }[];
  ledger?: Record<string, unknown>[];
}
export interface IntentProposal {
  version: 1; id: string; target: string; serverId: string; database: string; routingRevision: string;
  invoiceId: string; expectedCode: string; createdAt: string; expiresAt: string; policyDigest: string;
  headerPatch: Record<string, WriteScalar>;
  items: { id: string; patch: Record<string, WriteScalar> }[];
  accountingExpectation?: { rows: Record<string, WriteScalar>[] };
  snapshot: WriteSnapshot;
  payload: Record<string, unknown>;
  dryRun: {
    digest: string;
    expected: { invoice: Record<string, unknown>; items: { id: string; record: Record<string, unknown> }[] };
    changes: { header: Record<string, { from: unknown; to: unknown }>; items: { id: string; fields: Record<string, { from: unknown; to: unknown }> }[] };
  };
  digest: string;
}
export interface IntentState {
  status: 'prepared' | 'committing' | 'succeeded' | 'conflict' | 'rejected' | 'unknown';
  updatedAt: string; code?: string; receipt?: Record<string, unknown>;
}
export interface ApprovalPayload {
  kind: 'flexi-invoice-write-approval/v1'; intentId: string; target: string; digest: string; expiresAt: string;
}
export interface ApprovalEnvelope { payload: ApprovalPayload; signature: string }
export interface DocumentFence { intentId: string; target: string; digest: string; createdAt: string }

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  throw new FlexiError('WRITE_STORE_INVALID', 'Only canonical JSON values are supported.');
}
export function proposalDigest(proposal: Omit<IntentProposal, 'digest'> | IntentProposal): string {
  const { digest: _ignored, ...body } = proposal as IntentProposal;
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}
export function approvalPayload(intent: IntentProposal): ApprovalPayload {
  return { kind: 'flexi-invoice-write-approval/v1', intentId: intent.id, target: intent.target, digest: intent.digest, expiresAt: intent.expiresAt };
}
export function signApproval(intent: IntentProposal, privateKeyPem: string | Buffer): ApprovalEnvelope {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new FlexiError('APPROVAL_INVALID', 'An Ed25519 operator key is required.');
  const payload = approvalPayload(intent);
  return { payload, signature: sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64') };
}

/** Durable intent files are private; persistent locks are never guessed stale or auto-removed. */
export class IntentStore {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }

  async init(): Promise<void> {
    await mkdir(this.path, { recursive: true, mode: 0o700 });
    const info = await lstat(this.path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new FlexiError('WRITE_STORE_UNSAFE', 'Write store requires a private directory.');
  }

  async create(proposal: IntentProposal): Promise<void> {
    await this.init();
    validateId(proposal.id);
    if (proposal.version !== 1 || proposal.digest !== proposalDigest(proposal)) throw new FlexiError('WRITE_STORE_INVALID', 'Invalid intent digest.');
    await this.#writeNew(this.#file(proposal.id, 'proposal'), proposal);
    await this.#writeNew(this.#file(proposal.id, 'state'), { status: 'prepared', updatedAt: proposal.createdAt });
  }

  async get(id: string): Promise<IntentProposal> {
    await this.init(); validateId(id);
    const value = await this.#read(this.#file(id, 'proposal'));
    if (!isObject(value) || value.id !== id || value.version !== 1 || typeof value.target !== 'string' || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || value.digest !== proposalDigest(value as unknown as IntentProposal)) throw new FlexiError('WRITE_STORE_INVALID', 'Intent is invalid or changed.');
    return value as unknown as IntentProposal;
  }

  async readState(id: string): Promise<IntentState> {
    await this.init(); validateId(id);
    const value = await this.#read(this.#file(id, 'state'));
    if (!isObject(value) || !['prepared', 'committing', 'succeeded', 'conflict', 'rejected', 'unknown'].includes(String(value.status)) || typeof value.updatedAt !== 'string') throw new FlexiError('WRITE_STORE_INVALID', 'Invalid intent state.');
    return value as unknown as IntentState;
  }

  async writeState(id: string, state: IntentState): Promise<void> {
    await this.init(); validateId(id);
    await this.#writeAtomic(this.#file(id, 'state'), state);
  }

  async readApproval(id: string): Promise<ApprovalEnvelope | undefined> {
    await this.init(); validateId(id);
    let value: unknown;
    try { value = await this.#read(this.#file(id, 'approval')); }
    catch (error) { if (isErrno(error, 'ENOENT')) return undefined; throw error; }
    if (!isObject(value) || Object.keys(value).some(key => !['payload', 'signature'].includes(key)) || !isObject(value.payload) || typeof value.signature !== 'string' || value.signature.length > 256) throw new FlexiError('APPROVAL_INVALID', 'Invalid operator approval.');
    return value as unknown as ApprovalEnvelope;
  }

  async putApproval(id: string, approval: ApprovalEnvelope): Promise<void> {
    await this.withIntentLock(id, async () => {
      const intent = await this.get(id);
      const state = await this.readState(id);
      if (state.status !== 'prepared' || canonicalJson(approval.payload) !== canonicalJson(approvalPayload(intent))) throw new FlexiError('APPROVAL_INVALID', 'Approval does not match a prepared intent.');
      await this.#writeNew(this.#file(id, 'approval'), approval);
    });
  }

  async getDocumentFence(scopeKey: string): Promise<DocumentFence | undefined> {
    await this.init();
    let value: unknown;
    try { value = await this.#read(this.#fenceFile(scopeKey)); }
    catch (error) { if (isErrno(error, 'ENOENT')) return undefined; throw error; }
    if (!isObject(value) || typeof value.intentId !== 'string' || typeof value.target !== 'string' || typeof value.digest !== 'string' || typeof value.createdAt !== 'string') throw new FlexiError('WRITE_STORE_INVALID', 'Invalid document reconciliation fence.');
    validateId(value.intentId);
    return value as unknown as DocumentFence;
  }

  /** Caller must hold the physical document lock. A crash after this fsync fences every new intent. */
  async putDocumentFence(scopeKey: string, fence: DocumentFence): Promise<void> {
    await this.init(); validateId(fence.intentId);
    await this.#writeAtomic(this.#fenceFile(scopeKey), fence);
  }

  async withIntentLock<T>(id: string, run: () => Promise<T>): Promise<T> {
    validateId(id);
    return this.#withLock(`${id}.intent.lock`, run);
  }
  async withDocumentLock<T>(scopeKey: string, run: () => Promise<T>): Promise<T> {
    return this.#withLock(`document-${createHash('sha256').update(scopeKey).digest('hex')}.lock`, run);
  }

  #file(id: string, kind: string): string { return join(this.path, `${id}.${kind}.json`); }
  #fenceFile(scopeKey: string): string { return join(this.path, `document-${createHash('sha256').update(scopeKey).digest('hex')}.fence.json`); }

  async #withLock<T>(name: string, run: () => Promise<T>): Promise<T> {
    await this.init();
    const path = join(this.path, name);
    let file;
    try { file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (isErrno(error, 'EEXIST')) throw new FlexiError('WRITE_BUSY', 'Another operator or process owns the intent or document lock.'); throw error; }
    try {
      await file.writeFile(`${process.pid}\n`); await file.sync(); await this.#syncDirectory();
      return await run();
    } finally {
      await file.close(); await unlink(path); await this.#syncDirectory();
    }
  }

  async #read(path: string): Promise<unknown> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 2_097_152) throw new FlexiError('WRITE_STORE_UNSAFE', 'Unsafe or oversized intent file.');
      const bytes = await file.readFile();
      if (bytes.length > 2_097_152) throw new FlexiError('WRITE_STORE_UNSAFE', 'Oversized intent file.');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally { await file.close(); }
  }

  async #writeNew(path: string, value: unknown): Promise<void> {
    const bytes = canonicalJson(value) + '\n';
    if (Buffer.byteLength(bytes) > 2_097_152) throw new FlexiError('WRITE_STORE_INVALID', 'Intent exceeds the store size limit.');
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    await this.#syncDirectory();
  }

  async #writeAtomic(path: string, value: unknown): Promise<void> {
    const temporary = join(this.path, `.state-${randomUUID()}.tmp`);
    await this.#writeNew(temporary, value);
    try { await rename(temporary, path); await this.#syncDirectory(); }
    catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }
  async #syncDirectory(): Promise<void> {
    const directory = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new FlexiError('INTENT_NOT_FOUND', 'Invalid intent identifier.');
}
function isErrno(error: unknown, code: string): boolean { return error instanceof Error && 'code' in error && error.code === code; }
