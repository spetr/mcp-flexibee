import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FlexiClient, FlexiError } from '../src/flexi/client.ts';
import type { FetchFunction, FlexiConfig } from '../src/flexi/client.ts';
import { compileFilters } from '../src/flexi/policy.ts';

const config: FlexiConfig = {
  baseUrl: 'https://flexi.example.test:5434', company: 'demo_company',
  username: 'reader', password: 'secret-test-password', allowedEvidences: ['faktura-vydana', 'cenik'],
};
const schemaPayload = { properties: { property: [
  { propertyName: 'id', type: 'integer' }, { propertyName: 'kod', type: 'string' },
  { propertyName: 'sumCelkem', type: 'decimal' }, { propertyName: 'datVyst', type: 'date' },
  { propertyName: 'email', type: 'string', description: 'private metadata' },
] } };
function json(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });
}
function setup(records: unknown, overrides: Partial<FlexiConfig> = {}): { client: FlexiClient; calls: { url: URL; init?: RequestInit }[] } {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetcher: FetchFunction = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, ...(init ? { init } : {}) });
    return url.pathname.endsWith('/properties.json') ? json(schemaPayload) : json(records);
  };
  return { client: new FlexiClient({ ...config, ...overrides }, fetcher), calls };
}
const invoice = { winstrom: { '@rowCount': '1', 'faktura-vydana': [{ id: '42', kod: 'FV-42', sumCelkem: '1200.50' }] } };

test('constructs bounded GET at the configured origin and projects only requested scalars', async () => {
  const { client, calls } = setup({ winstrom: { '@rowCount': '1', 'faktura-vydana': [{
    id: '42', kod: 'FV-42', sumCelkem: '1200.50', email: 'private@example.test',
    'mena@showAs': 'private', 'id@ref': 'https://evil.example', nested: { secret: 'hidden' },
  }] } });
  assert.deepEqual(await client.listRecords({ evidence: 'faktura-vydana', fields: ['id', 'sumCelkem'], limit: 10 }), {
    records: [{ id: '42', sumCelkem: '1200.50' }], rowCount: 1,
  });
  assert.equal(calls.length, 2);
  const request = calls[1]!;
  assert.equal(request.url.origin, config.baseUrl);
  assert.equal(request.url.pathname, '/c/demo_company/faktura-vydana.json');
  assert.deepEqual(Object.fromEntries(request.url.searchParams), {
    auth: 'http', detail: 'custom:id,sumCelkem', limit: '10', start: '0', order: 'id', 'add-row-count': 'true',
  });
  assert.equal(request.init?.method, 'GET');
  assert.equal(request.init?.redirect, 'error');
  assert.equal(new Headers(request.init?.headers).get('authorization'), 'Basic cmVhZGVyOnNlY3JldC10ZXN0LXBhc3N3b3Jk');
});

test('schema returns known names and local types without descriptions, and caches safely', async () => {
  const { client, calls } = setup(invoice);
  const first = await client.schema('faktura-vydana');
  assert.deepEqual(first.properties, [
    { name: 'id', type: 'integer' }, { name: 'kod', type: 'string' },
    { name: 'sumCelkem', type: 'decimal' }, { name: 'datVyst', type: 'date' },
  ]);
  first.properties[0]!.name = 'corrupted';
  assert.equal((await client.schema('faktura-vydana')).properties[0]!.name, 'id');
  assert.equal(calls.length, 1);
});

test('typed filters emit only safe documented grammar', async () => {
  assert.equal(compileFilters('faktura-vydana', [
    { field: 'datVyst', op: 'gte', value: '2026-01-01' },
    { field: 'sumCelkem', op: 'gt', value: '10.05' },
    { field: 'kod', op: 'contains', value: 'FV 26' },
  ]), "datVyst gte 2026-01-01 and sumCelkem gt 10.05 and kod like 'FV 26'");
  const { client, calls } = setup(invoice);
  await client.listRecords({ evidence: 'faktura-vydana', fields: ['id'], filters: [{ field: 'kod', op: 'eq', value: 'FV-42' }] });
  assert.equal(decodeURIComponent(calls[1]!.url.pathname), "/c/demo_company/faktura-vydana/(kod eq 'FV-42').json");
});

test('unsafe configuration is rejected without sending a request', () => {
  for (const baseUrl of ['http://x.test', 'https://u:p@x.test', 'https://x.test/path', 'https://x.test/?password=p', 'https://x.test/#x']) {
    assert.throws(() => new FlexiClient({ ...config, baseUrl }), FlexiError);
  }
  for (const company of ['../admin', 'a/b', 'x%2f', '', '.']) assert.throws(() => new FlexiClient({ ...config, company }), FlexiError);
  assert.throws(() => new FlexiClient({ ...config, allowedEvidences: ['banka'] }), FlexiError);
});

test('input allowlists and unknown parameters fail before any fetch', async () => {
  const { client, calls } = setup(invoice);
  const inputs: unknown[] = [
    { evidence: 'banka', fields: ['id'] }, { evidence: 'adresar', fields: ['id'] },
    { evidence: '../cenik', fields: ['id'] }, { evidence: 'faktura-vydana', fields: ['email'] },
    { evidence: 'faktura-vydana', fields: ['id', 'id'] }, { evidence: 'faktura-vydana', fields: [] },
    { evidence: 'faktura-vydana', fields: ['id'], limit: 0 },
    { evidence: 'faktura-vydana', fields: ['id'], limit: 101 },
    { evidence: 'faktura-vydana', fields: ['id'], start: 10001 },
    { evidence: 'faktura-vydana', fields: ['id'], path: 'https://evil.test' },
    { evidence: 'faktura-vydana', fields: ['id'], filters: [{ field: 'firma.email', op: 'eq', value: 'x' }] },
  ];
  for (const input of inputs) await assert.rejects(client.listRecords(input as never), { code: 'INVALID_INPUT' });
  assert.equal(calls.length, 0);
});

test('filters reject injection, nonstring money and malformed typed values', () => {
  for (const value of ["x' or id gt 0", 'x"', 'x\\', 'x\n', '%27', 'x/y', '(id)', 'now()', 'x\u202e']) {
    assert.throws(() => compileFilters('faktura-vydana', [{ field: 'kod', op: 'eq', value }]), FlexiError);
  }
  for (const condition of [
    { field: 'sumCelkem', op: 'eq', value: 0.1 }, { field: 'sumCelkem', op: 'eq', value: '1e2' },
    { field: 'datVyst', op: 'eq', value: '2026-02-30' }, { field: 'datVyst', op: 'contains', value: '2026' },
    { field: 'id', op: 'eq', value: '01' }, { field: 'kod', op: 'raw', value: 'x' },
    { field: 'kod', op: 'eq', value: 'x', raw: 'evil' },
  ]) assert.throws(() => compileFilters('faktura-vydana', [condition]), FlexiError);
});

test('detail only accepts numeric IDs and verifies the returned ID', async () => {
  const { client, calls } = setup(invoice);
  for (const id of ['code:ABC', 'ext:A:B', '../1', '1?x=1', '0', '01']) await assert.rejects(client.getRecord({ evidence: 'faktura-vydana', fields: ['id'], id }), FlexiError);
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.getRecord({ evidence: 'faktura-vydana', id: '42', fields: ['id'] }), { records: [{ id: '42' }], rowCount: 1 });
  assert.equal(calls[1]!.url.pathname, '/c/demo_company/faktura-vydana/42.json');
  assert.deepEqual(await client.getRecord({ evidence: 'faktura-vydana', id: '42', fields: ['kod'] }), { records: [{ kod: 'FV-42' }], rowCount: 1 });
  assert.equal(calls[2]!.url.searchParams.get('detail'), 'custom:id,kod');
  await assert.rejects(client.getRecord({ evidence: 'faktura-vydana', id: '43', fields: ['id'] }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(client.getRecord({ evidence: 'faktura-vydana', id: '43', fields: ['kod'] }), { code: 'INVALID_RESPONSE' });
});

test('later pages are bounded and omit expensive row count', async () => {
  const { client, calls } = setup(invoice);
  await client.listRecords({ evidence: 'faktura-vydana', fields: ['id'], start: 10000, limit: 100 });
  assert.equal(calls[1]!.url.searchParams.get('add-row-count'), null);
});

test('runtime schema excludes unavailable fields', async () => {
  const { client, calls } = setup(invoice);
  await assert.rejects(client.listRecords({ evidence: 'faktura-vydana', fields: ['varSym'] }), { code: 'INVALID_INPUT' });
  assert.equal(calls.length, 1);
});

test('cross-evidence envelopes, missing fields, nested fields, floats and row counts are rejected', async () => {
  const payloads = [
    { winstrom: { cenik: [{ id: '42' }] } },
    { winstrom: { 'faktura-vydana': [{}] } },
    { winstrom: { 'faktura-vydana': [{ id: { '@ref': 'secret' } }] } },
    { winstrom: { 'faktura-vydana': [{ id: '42', sumCelkem: 1.1 }] } },
    { winstrom: { '@rowCount': '1secret', 'faktura-vydana': [{ id: '42' }] } },
    { winstrom: { 'faktura-vydana': 'not-array' } },
  ];
  for (const payload of payloads) {
    const { client } = setup(payload);
    await assert.rejects(client.listRecords({ evidence: 'faktura-vydana', fields: payloads.indexOf(payload) === 3 ? ['id', 'sumCelkem'] : ['id'] }), { code: 'INVALID_RESPONSE' });
  }
});

test('upstream cannot exceed the requested page size', async () => {
  const { client } = setup({ winstrom: { 'faktura-vydana': [{ id: '1' }, { id: '2' }] } });
  await assert.rejects(client.listRecords({ evidence: 'faktura-vydana', fields: ['id'], limit: 1 }), { code: 'INVALID_RESPONSE' });
});

test('redirects, HTML, malformed JSON, oversize bodies and upstream errors are sanitized', async () => {
  const responses: (() => Response)[] = [
    () => new Response('secret', { status: 302, headers: { location: 'https://evil.test' } }),
    () => new Response('<html>secret</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{secret', { headers: { 'content-type': 'application/json' } }),
    () => json({ secret: 'x'.repeat(300) }),
    () => new Response('secret', { status: 401 }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '99999' } }),
  ];
  for (const response of responses) {
    const client = new FlexiClient({ ...config, maxResponseBytes: 200 }, async () => response());
    await assert.rejects(client.schema('cenik'), error => error instanceof FlexiError && !error.message.includes('secret'));
  }
  const client = new FlexiClient(config, async () => { throw new Error('password=secret'); });
  await assert.rejects(client.schema('cenik'), { code: 'UPSTREAM_ERROR', message: 'Flexi request failed.' });
});

test('schema rejects malformed, excessive and duplicate metadata', async () => {
  for (const payload of [
    { properties: { property: [null] } }, { properties: { property: [{ propertyName: 'id' }, { propertyName: 'id' }] } },
    { properties: { property: Array.from({ length: 501 }, () => ({ propertyName: 'id' })) } },
    { properties: { property: [{ propertyName: 'email' }] } },
    { properties: { property: [{ name: 'id' }] } },
  ]) {
    const client = new FlexiClient(config, async () => json(payload));
    await assert.rejects(client.schema('cenik'), { code: 'INVALID_RESPONSE' });
  }
});

test('deadline covers the entire streaming body, including an unresponsive injected transport', async () => {
  let canceled = false;
  const client = new FlexiClient({ ...config, timeoutMs: 10 }, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { canceled = true; },
  }), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(client.schema('cenik'), { code: 'TIMEOUT' });
  assert.equal(canceled, true);
});

test('concurrency is bounded without retrying requests', async () => {
  let calls = 0;
  const client = new FlexiClient({ ...config, timeoutMs: 30 }, async () => { calls++; return new Promise<Response>(() => undefined); });
  const requests = Array.from({ length: 4 }, () => client.schema('cenik'));
  await assert.rejects(client.schema('cenik'), { code: 'BUSY' });
  await Promise.all(requests.map(request => assert.rejects(request, { code: 'TIMEOUT' })));
  assert.equal(calls, 4);
});
