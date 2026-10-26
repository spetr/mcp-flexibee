import { FlexiError } from './policy.ts';
import type { CredentialConfig, ServerConfig } from '../config.ts';
import type { FetchFunction, SharedRequestBudget } from './client.ts';

/** Shared by every configured alias and credential profile on the same origin. */
export class OriginBudget implements SharedRequestBudget {
  #active = 0;
  #used = 0;
  #windowStart = Date.now();
  readonly maxConcurrent: number;
  readonly perMinute: number;
  constructor(maxConcurrent: number, perMinute: number) { this.maxConcurrent = maxConcurrent; this.perMinute = perMinute; }
  acquire(): () => void {
    const now = Date.now();
    if (now - this.#windowStart >= 60_000) { this.#windowStart = now; this.#used = 0; }
    if (this.#active >= this.maxConcurrent) throw new FlexiError('BUSY', 'API server request concurrency is exhausted.');
    if (this.#used >= this.perMinute) throw new FlexiError('RATE_LIMITED', 'API server request budget is exhausted.');
    this.#active++; this.#used++;
    let released = false;
    return () => { if (!released) { released = true; this.#active--; } };
  }
}

/** Abort is issued before this bounded cancellation handshake. */
export async function cancelBody(reader: ReadableStreamDefaultReader<Uint8Array> | undefined): Promise<void> {
  if (!reader) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reader.cancel().catch(() => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 100); }),
    ]);
  } catch { /* A cancellation failure must not expose an upstream error. */ }
  finally { if (timer) clearTimeout(timer); }
}

/** Only the server-level company catalogue is exposed here; not a generic proxy. */
export async function readCompanyJson(url: URL, server: ServerConfig, credential: CredentialConfig, fetcher: FetchFunction, budget: SharedRequestBudget): Promise<unknown> {
  if (url.origin !== server.baseUrl || url.pathname !== '/c.json') throw new FlexiError('INVALID_INPUT', 'Invalid company discovery route.');
  const release = budget.acquire();
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new FlexiError('TIMEOUT', 'Company discovery timed out.')); }, server.timeoutMs);
  });
  try {
    const operation = async (): Promise<unknown> => {
      const response = await fetcher(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(`${credential.username}:${credential.password}`).toString('base64') } });
      if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== server.baseUrl)) throw new FlexiError('UPSTREAM_ERROR', 'Company discovery request failed.');
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (mime !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(mime ?? '')) throw new FlexiError('INVALID_RESPONSE', 'Company discovery did not return JSON.');
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > server.maxResponseBytes)) throw new FlexiError('RESPONSE_TOO_LARGE', 'Company discovery response exceeds the limit.');
      if (!response.body) throw new FlexiError('INVALID_RESPONSE', 'Empty company discovery response.');
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > server.maxResponseBytes) throw new FlexiError('RESPONSE_TOO_LARGE', 'Company discovery response exceeds the limit.');
        chunks.push(part.value);
      }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new FlexiError('INVALID_RESPONSE', 'Invalid company discovery JSON.'); }
    };
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    if (timedOut) throw new FlexiError('TIMEOUT', 'Company discovery timed out.');
    if (error instanceof FlexiError) throw error;
    throw new FlexiError('UPSTREAM_ERROR', 'Company discovery request failed.');
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    await cancelBody(reader);
    release();
  }
}
