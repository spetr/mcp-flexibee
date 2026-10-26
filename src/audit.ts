import { constants } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface AuditEvent {
  requestId: string;
  at: string;
  operation: string;
  connection: string;
  scope?: 'global' | 'server' | 'company' | 'unresolved';
  target?: string;
  serverId?: string;
  companyId?: string;
  database?: string;
  environment?: 'production' | 'test';
  readOnly?: boolean;
  outcome: 'started' | 'success' | 'error';
  code?: string;
}
export interface AuditSink { record(event: AuditEvent): Promise<void> }
const MAX_AUDIT_BYTES = 8 * 1024 * 1024;

/** Local hash chain detects accidental edits; it is not an externally anchored WORM audit. */
export class AuditLog implements AuditSink {
  readonly #file: FileHandle;
  readonly #lock: FileHandle;
  readonly #lockPath: string;
  #previousHash: string;
  #size: number;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(file: FileHandle, lock: FileHandle, lockPath: string, previousHash: string, size: number) {
    this.#file = file; this.#lock = lock; this.#lockPath = lockPath;
    this.#previousHash = previousHash; this.#size = size;
  }

  static async create(path: string): Promise<AuditLog> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.lock`;
    // Never infer that a lock is stale from a PID: PID reuse and startup races
    // would allow two independent writers to fork the chain.
    const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let file: FileHandle | undefined;
    try {
      await lock.writeFile(`${process.pid}\n`); await lock.sync();
      file = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > MAX_AUDIT_BYTES) throw new Error('Unsafe audit file.');
      const bytes = await file.readFile({ encoding: 'utf8' });
      let previousHash = '0'.repeat(64);
      if (bytes && !bytes.endsWith('\n')) throw new Error('Incomplete audit record.');
      for (const line of bytes.split('\n').filter(Boolean)) {
        const row = JSON.parse(line) as { event: AuditEvent; previousHash: string; hash: string };
        if (row.previousHash !== previousHash || row.hash !== digest(previousHash, row.event)) throw new Error('Invalid audit chain.');
        previousHash = row.hash;
      }
      return new AuditLog(file, lock, lockPath, previousHash, info.size);
    } catch (error) {
      if (file) await file.close();
      await lock.close(); await unlink(lockPath);
      throw error;
    }
  }

  record(event: AuditEvent): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Audit is closed.'));
    const safeEvent = { ...event };
    this.#tail = this.#tail.then(async () => {
      const hash = digest(this.#previousHash, safeEvent);
      const line = `${JSON.stringify({ event: safeEvent, previousHash: this.#previousHash, hash })}\n`;
      const size = Buffer.byteLength(line);
      if (this.#size + size > MAX_AUDIT_BYTES) throw new Error('Audit capacity reached; rotate offline.');
      await this.#file.appendFile(line, 'utf8');
      await this.#file.sync();
      this.#size += size; this.#previousHash = hash;
    });
    return this.#tail;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try { await this.#tail; } finally {
      await this.#file.close();
      await this.#lock.close();
      await unlink(this.#lockPath);
    }
  }
}

function digest(previousHash: string, event: AuditEvent): string {
  return createHash('sha256').update(previousHash).update('\n').update(JSON.stringify(event)).digest('hex');
}
