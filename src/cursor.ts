import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class CursorError extends Error {
  readonly code = 'INVALID_CURSOR';
  constructor() { super('Cursor is invalid, expired, or belongs to a different query.'); }
}
export class CursorSigner {
  readonly #key = randomBytes(32);
  readonly #now: () => number;
  constructor(now: () => number = Date.now) { this.#now = now; }

  issue(binding: unknown, start: number): string {
    const body = Buffer.from(JSON.stringify({ binding: fingerprint(binding), start, expiresAt: this.#now() + 900_000 })).toString('base64url');
    return `${body}.${this.#sign(body).toString('base64url')}`;
  }

  verify(token: string, binding: unknown): number {
    if (token.length > 2048) throw new CursorError();
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[a-zA-Z0-9_-]+$/.test(parts[0]) || !/^[a-zA-Z0-9_-]+$/.test(parts[1])) throw new CursorError();
    const signature = Buffer.from(parts[1], 'base64url');
    const expected = this.#sign(parts[0]);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new CursorError();
    let payload: { binding: string; start: number; expiresAt: number };
    try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as typeof payload; } catch { throw new CursorError(); }
    if (!payload || payload.binding !== fingerprint(binding) || !Number.isSafeInteger(payload.start) || payload.start < 1 || payload.start > 10_000 || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= this.#now()) throw new CursorError();
    return payload.start;
  }

  #sign(body: string): Buffer { return createHmac('sha256', this.#key).update(body).digest(); }
}
function fingerprint(binding: unknown): string { return createHash('sha256').update(JSON.stringify(binding)).digest('hex'); }
