import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.ts';
import type { AppConfig, ServerConfig } from '../src/config.ts';
import { ConnectionRegistry } from '../src/connections.ts';
import type { FetchFunction } from '../src/flexi/client.ts';

const base = (): AppConfig => ({ connectionName: 'main', auditPath: '/tmp/not-opened-audit', corpusMaxAgeDays: 7, callsPerMinute: 60 });
const server = (id: string, baseUrl = `https://${id}.example.test`): ServerConfig => ({ id, label: id, baseUrl,
  credentials: { reader: { username: `${id}-reader`, password: `${id}-secret` } },
  companies: ['a', 'b'].map(id => ({ id, label: `Company ${id}`, database: id, credentialId: 'reader', environment: id === 'a' ? 'production' : 'test', allowedEvidences: ['faktura-prijata'] })),
  limits: { maxConcurrentRequests: 4, requestsPerMinute: 60 }, timeoutMs: 1000, maxResponseBytes: 1_048_576,
});
const json = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
const companies = (state = 'ESTABLISHED', show = 'true') => ({ companies: { company: ['a', 'b'].map(dbNazev => ({ id: '-2', dbNazev, nazev: `Company ${dbNazev}`, show, stavEnum: state })) } });
const properties = { properties: { property: [{ propertyName: 'id', type: 'integer' }, { propertyName: 'kod', type: 'string' }, { propertyName: 'nazFirmy', type: 'string' }] } };
const evidences = { evidences: { evidence: [{ evidencePath: 'faktura-prijata', evidenceName: 'Invoices', evidenceType: 'INVOICE', evidenceAccess: 'true' }] } };

function fixture(servers: ServerConfig[]) {
  const requests: { url: URL; authorization: string | null }[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const url = new URL(String(input));
    const configured = servers.find(item => item.baseUrl === url.origin)!;
    assert.ok(configured, 'known origin');
    assert.equal(init?.method, 'GET'); assert.equal(init.redirect, 'error');
    const authorization = new Headers(init.headers).get('authorization');
    assert.equal(authorization, 'Basic ' + Buffer.from(`${configured.id}-reader:${configured.id}-secret`).toString('base64'));
    requests.push({ url, authorization });
    await new Promise(resolve => setTimeout(resolve, url.hostname.startsWith('north') ? 3 : 1));
    if (url.pathname === '/c.json') return json(companies());
    const database = url.pathname.split('/')[2];
    assert.ok(['a', 'b'].includes(database!));
    if (url.pathname.endsWith('properties.json')) return json(properties);
    if (url.pathname.endsWith('evidence-list.json')) return json(evidences);
    return json({ winstrom: { 'faktura-prijata': [{ id: '1', kod: `${configured.id}:${database}`, nazFirmy: `${configured.id} ${database}` }] } });
  };
  return { fetch, requests };
}

function fileConfig() {
  return { version: 1, readOnly: true, limits: { maxConcurrentCalls: 3, callsPerMinute: 50 }, servers: [{ id: 'north', label: 'North', baseUrl: 'https://north.example.test', credentials: { reader: { usernameEnv: 'READER_USER', passwordEnv: 'READER_PASSWORD' } }, companies: [{ id: 'a', label: 'A', database: 'a', credentialId: 'reader', environment: 'production', allowedEvidences: ['*'] }] }] };
}

test('multi-config resolves only env secret references and rejects ambiguous, invalid or mutating configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flexi-connections-config-'));
  const path = join(dir, 'connections.json');
  const env = { FLEXI_CONFIG_PATH: path, READER_USER: 'reader', READER_PASSWORD: 'not-printed-secret' };
  try {
    writeFileSync(path, JSON.stringify(fileConfig()));
    const config = loadConfig(env);
    assert.equal(config.servers?.[0]?.credentials.reader?.password, env.READER_PASSWORD);
    assert.equal(config.flexi, undefined); assert.equal(config.callsPerMinute, 50); assert.equal(config.maxConcurrentCalls, 3);
    for (const extra of [{ FLEXI_BASE_URL: 'https://x.test' }, { FLEXI_COMPANY: 'a' }, { FLEXI_CONNECTION_NAME: 'main' }]) assert.throws(() => loadConfig({ ...env, ...extra }), ConfigError);
    assert.throws(() => loadConfig(env, dir, true), ConfigError);
    assert.throws(() => loadConfig({ ...env, READER_PASSWORD: undefined }), ConfigError);
    const variants = [
      { ...fileConfig(), readOnly: false },
      { ...fileConfig(), arbitraryUrl: 'https://evil.test' },
      { ...fileConfig(), servers: [fileConfig().servers[0], fileConfig().servers[0]] },
    ];
    for (const value of variants) { writeFileSync(path, JSON.stringify(value)); assert.throws(() => loadConfig(env), ConfigError); }
    for (const baseUrl of ['http://x.test', 'https://u:p@x.test', 'https://x.test/path', 'https://x.test/?token=secret']) {
      const value = fileConfig(); value.servers[0]!.baseUrl = baseUrl; writeFileSync(path, JSON.stringify(value)); assert.throws(() => loadConfig(env), ConfigError);
    }
    const unknownCredential = fileConfig(); unknownCredential.servers[0]!.companies[0]!.credentialId = 'other'; writeFileSync(path, JSON.stringify(unknownCredential));
    assert.throws(() => loadConfig(env), ConfigError);
    const duplicates = fileConfig(); duplicates.servers[0]!.companies.push(duplicates.servers[0]!.companies[0]!); writeFileSync(path, JSON.stringify(duplicates));
    assert.throws(() => loadConfig(env), ConfigError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two servers and four immutable targets keep origins, credentials and identical document IDs isolated in parallel', async () => {
  const servers = [server('north'), server('south')];
  const { fetch, requests } = fixture(servers);
  const registry = new ConnectionRegistry({ ...base(), servers }, { fetch });
  const handles = registry.targets().map(target => registry.resolve(target.target));
  assert.throws(() => registry.resolve(), { code: 'TARGET_REQUIRED' });
  for (const target of ['north/a/extra', 'https://evil.test', '../a', 'north/%2fa', 'unknown/a']) assert.throws(() => registry.resolve(target), { code: 'TARGET_NOT_FOUND' });
  assert.equal(requests.length, 0);
  assert.ok(handles.every(Object.isFrozen));
  const values = await Promise.all(handles.map(async handle => {
    await registry.ensureReady(handle);
    return (await handle.client.getRecord({ evidence: 'faktura-prijata', id: '1', fields: ['id', 'kod'] })).records[0]?.kod;
  }));
  assert.deepEqual(values.sort(), ['north:a', 'north:b', 'south:a', 'south:b']);
  assert.equal(requests.filter(req => req.url.pathname === '/c.json').length, 2, 'inflight discovery coalesced per profile');
  assert.ok(registry.targets().every(target => target.state === 'ESTABLISHED' && target.accessible === true && target.companyName));
  assert.doesNotMatch(JSON.stringify([registry.servers(), registry.targets()]), /north-secret|south-secret|Authorization/);
});

test('an unavailable second target cannot cause fallback; unknown company states deny data access', async () => {
  for (const state of ['ESTABLISHING', 'MAINTENANCE', '', 'UNRECOGNIZED']) {
    const registry = new ConnectionRegistry({ ...base(), servers: [server('north')] }, { fetch: async () => json(companies(state)) });
    assert.throws(() => registry.resolve(), { code: 'TARGET_REQUIRED' });
    await assert.rejects(registry.ensureReady(registry.resolve('north/b')), { code: 'COMPANY_NOT_READY' });
  }
  const registry = new ConnectionRegistry({ ...base(), servers: [server('north')] }, { fetch: async () => json({ companies: { company: [{ dbNazev: 'a', nazev: 'A', show: 'true', stavEnum: 'ESTABLISHED' }] } }) });
  await registry.ensureReady(registry.resolve('north/a'));
  await assert.rejects(registry.ensureReady(registry.resolve('north/b')), { code: 'COMPANY_NOT_VISIBLE' });
  assert.throws(() => registry.resolve(), { code: 'TARGET_REQUIRED' });
  const denied = new ConnectionRegistry({ ...base(), servers: [server('north')] }, { fetch: async () => json(companies('ESTABLISHED', 'false')) });
  await assert.rejects(denied.ensureReady(denied.resolve('north/a')), { code: 'COMPANY_NOT_VISIBLE' });
});

test('readiness uses all discovery pages and dbNazev rather than duplicated numeric company id', async () => {
  const source = server('north');
  const pages: number[] = [];
  const registry = new ConnectionRegistry({ ...base(), servers: [source] }, { fetch: async input => {
    const url = new URL(String(input)); const start = Number(url.searchParams.get('start')); pages.push(start);
    const rows = start === 0 ? Array.from({ length: 100 }, (_, n) => ({ id: '-2', dbNazev: `unused${n}`, nazev: 'Unused', show: 'true', stavEnum: 'ESTABLISHED' })) : [{ id: '-2', dbNazev: 'b', nazev: 'Second page company', show: 'true', stavEnum: 'ESTABLISHED' }];
    return json({ companies: { company: rows } });
  } });
  await registry.ensureReady(registry.resolve('north/b'));
  assert.deepEqual(pages, [0, 100]);
  assert.equal(registry.targets().find(target => target.companyId === 'b')?.companyName, 'Second page company');
});

test('mixed wildcard and restricted targets do not transfer fields or schema cache', async () => {
  const source = server('north');
  const mixed: ServerConfig = { ...source, companies: source.companies.map(company => ({ ...company, allowedEvidences: company.id === 'a' ? ['*'] : ['faktura-prijata'] })) };
  const { fetch, requests } = fixture([mixed]);
  const registry = new ConnectionRegistry({ ...base(), servers: [mixed] }, { fetch });
  const a = registry.resolve('north/a'); const b = registry.resolve('north/b');
  assert.ok((await a.client.schema('faktura-prijata')).properties.some(field => field.name === 'nazFirmy'));
  assert.ok(!(await b.client.schema('faktura-prijata')).properties.some(field => field.name === 'nazFirmy'));
  const count = requests.length;
  await assert.rejects(b.client.listRecords({ evidence: 'faktura-prijata', fields: ['nazFirmy'] }), { code: 'INVALID_INPUT' });
  assert.equal(requests.length, count);
});

test('company pagination advertises truncation and readiness never treats truncated discovery as a complete list', async () => {
  const source = { ...server('north'), limits: { maxConcurrentRequests: 4, requestsPerMinute: 600 } };
  const registry = new ConnectionRegistry({ ...base(), servers: [source] }, { fetch: async input => {
    const start = Number(new URL(String(input)).searchParams.get('start'));
    return json({ companies: { company: Array.from({ length: 100 }, (_, index) => ({ dbNazev: `company${start + index}`, nazev: 'Many companies', show: 'true', stavEnum: 'ESTABLISHED' })) } });
  } });
  const last = await registry.companies('north', 'reader', 10_000, 100);
  assert.equal(last.nextOffset, null);
  assert.equal(last.truncated, true);
  await assert.rejects(registry.ensureReady(registry.resolve('north/a')), { code: 'DISCOVERY_LIMIT' });
});

test('explicit partial discovery invalidates an earlier complete ready snapshot', async () => {
  const source = server('north');
  let state = 'ESTABLISHED';
  const registry = new ConnectionRegistry({ ...base(), servers: [source] }, { fetch: async input => {
    const url = new URL(String(input));
    const start = Number(url.searchParams.get('start'));
    const limit = Number(url.searchParams.get('limit'));
    return json({ companies: { company: companies(state).companies.company.slice(start, start + limit) } });
  } });
  const target = registry.resolve('north/a');
  await registry.ensureReady(target);
  state = 'MAINTENANCE';
  const partial = await registry.companies('north', 'reader', 0, 1);
  assert.equal(partial.nextOffset, 1);
  assert.equal(registry.targets()[0]?.state, 'MAINTENANCE');
  await assert.rejects(registry.ensureReady(target), { code: 'COMPANY_NOT_READY' });
});

test('a complete direct catalogue marks disappeared configured companies not visible while partial pages do not', async () => {
  let rows = companies().companies.company;
  const registry = new ConnectionRegistry({ ...base(), servers: [server('north')] }, { fetch: async input => {
    const url = new URL(String(input));
    const start = Number(url.searchParams.get('start')); const limit = Number(url.searchParams.get('limit'));
    return json({ companies: { company: rows.slice(start, start + limit) } });
  } });
  await registry.ensureReady(registry.resolve('north/b'));
  assert.equal(registry.targets().find(target => target.companyId === 'b')?.companyName, 'Company b');
  rows = rows.filter(row => row.dbNazev === 'a');
  const partial = await registry.companies('north', 'reader', 0, 1);
  assert.equal(partial.nextOffset, 1);
  assert.equal(registry.targets().find(target => target.companyId === 'b')?.accessible, true, 'one page cannot prove absence');
  await registry.companies('north');
  const missing = registry.targets().find(target => target.companyId === 'b')!;
  assert.equal(missing.state, 'NOT_VISIBLE');
  assert.equal(missing.accessible, false);
  assert.equal(missing.companyName, undefined);
  await assert.rejects(registry.ensureReady(registry.resolve('north/b')), { code: 'COMPANY_NOT_VISIBLE' });
});

test('publishing a complete multi-page readiness snapshot also clears vanished companies from target metadata', async () => {
  let paged = false;
  const registry = new ConnectionRegistry({ ...base(), servers: [server('north')] }, { fetch: async input => {
    if (!paged) return json(companies());
    const start = Number(new URL(String(input)).searchParams.get('start'));
    const rows = start === 0
      ? [{ id: '-2', dbNazev: 'a', nazev: 'Still present', show: 'true', stavEnum: 'ESTABLISHED' }, ...Array.from({ length: 99 }, (_, n) => ({ id: '-2', dbNazev: `other${n}`, nazev: 'Other', show: 'true', stavEnum: 'ESTABLISHED' }))]
      : [];
    return json({ companies: { company: rows } });
  } });
  await registry.ensureReady(registry.resolve('north/b'));
  assert.equal(registry.targets().find(target => target.companyId === 'b')?.accessible, true);
  paged = true;
  // Explicit partial refresh invalidates the old complete cache without proving absence.
  await registry.companies('north', 'reader', 0, 100);
  assert.equal(registry.targets().find(target => target.companyId === 'b')?.accessible, true);
  await registry.ensureReady(registry.resolve('north/a'));
  const missing = registry.targets().find(target => target.companyId === 'b')!;
  assert.equal(missing.state, 'NOT_VISIBLE');
  assert.equal(missing.accessible, false);
  assert.equal(missing.companyName, undefined);
});

test('delayed old discovery cannot overwrite newer maintenance or access denial observations and readiness', async () => {
  for (const current of [
    { state: 'MAINTENANCE', show: 'true', pageSize: 100, code: 'COMPANY_NOT_READY' },
    { state: 'ESTABLISHED', show: 'false', pageSize: 1, code: 'COMPANY_NOT_VISIBLE' },
  ]) {
    let requestCount = 0;
    let releaseOld!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const registry = new ConnectionRegistry({ ...base(), servers: [server('north')] }, { fetch: async input => {
      requestCount++;
      if (requestCount === 1) {
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          releaseOld = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(companies('ESTABLISHED', 'true'))));
            controller.close();
          };
          firstStarted();
        } }), { headers: { 'content-type': 'application/json' } });
      }
      const url = new URL(String(input));
      const start = Number(url.searchParams.get('start'));
      const limit = Number(url.searchParams.get('limit'));
      const rows = companies(current.state, current.show).companies.company.map(row => ({ ...row, nazev: `Fresh ${row.dbNazev}` }));
      return json({ companies: { company: rows.slice(start, start + limit) } });
    } });
    const target = registry.resolve('north/a');
    const oldReadiness = assert.rejects(registry.ensureReady(target), { code: 'DISCOVERY_CHANGED' });
    await started;
    await registry.companies('north', 'reader', 0, current.pageSize);
    assert.equal(registry.targets()[0]?.companyName, 'Fresh a');
    releaseOld();
    await oldReadiness;
    const observed = registry.targets()[0]!;
    assert.equal(observed.state, current.state);
    assert.equal(observed.accessible, current.show === 'true');
    assert.equal(observed.companyName, 'Fresh a');
    await assert.rejects(registry.ensureReady(target), { code: current.code });
    if (current.pageSize === 100) assert.equal(requestCount, 2, 'new complete denial snapshot remains cached');
  }
});

test('company discovery and caches are scoped to credential profiles and reject ambiguous profile selection', async () => {
  const source = server('north');
  const profiled: ServerConfig = { ...source,
    credentials: { first: { username: 'first', password: 'one' }, second: { username: 'second', password: 'two' } },
    companies: source.companies.map(company => ({ ...company, database: 'shared', credentialId: company.id === 'a' ? 'first' : 'second' })),
  };
  const auths: string[] = [];
  const registry = new ConnectionRegistry({ ...base(), servers: [profiled] }, { fetch: async (_input, init) => {
    const authorization = new Headers(init?.headers).get('authorization')!; auths.push(authorization);
    const first = authorization === 'Basic ' + Buffer.from('first:one').toString('base64');
    return json({ companies: { company: [{ dbNazev: 'shared', nazev: first ? 'Visible for first' : 'Hidden for second', show: first ? 'true' : 'false', stavEnum: 'ESTABLISHED' }] } });
  } });
  await assert.rejects(registry.companies('north'), { code: 'CREDENTIAL_REQUIRED' });
  assert.equal(auths.length, 0);
  await registry.ensureReady(registry.resolve('north/a'));
  await assert.rejects(registry.ensureReady(registry.resolve('north/b')), { code: 'COMPANY_NOT_VISIBLE' });
  assert.equal(auths.length, 2);
});

test('origin-level request quotas cannot be multiplied by server aliases or credential profiles', async () => {
  const first = { ...server('north'), limits: { maxConcurrentRequests: 4, requestsPerMinute: 1 } };
  const alias = { ...server('alias', first.baseUrl), limits: { maxConcurrentRequests: 4, requestsPerMinute: 60 } };
  let requests = 0;
  const registry = new ConnectionRegistry({ ...base(), servers: [first, alias] }, { fetch: async () => { requests++; return json(companies()); } });
  await registry.companies('north');
  await assert.rejects(registry.companies('alias'), { code: 'RATE_LIMITED' });
  assert.equal(requests, 1);
});

test('shared concurrency remains held while a response body is being read, including company discovery', async () => {
  const source = { ...server('north'), limits: { maxConcurrentRequests: 1, requestsPerMinute: 60 } };
  let emit: (() => void) | undefined;
  const registry = new ConnectionRegistry({ ...base(), servers: [source] }, { fetch: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      emit = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(companies()))); controller.close(); };
    },
  }), { headers: { 'content-type': 'application/json' } }) });
  const pending = registry.companies('north');
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(registry.resolve('north/b').client.schema('faktura-prijata'), { code: 'BUSY' });
  emit!(); await pending;
});

test('company discovery rejects redirects, malformed envelopes and oversized or stalled bodies', async () => {
  const source = { ...server('north'), timeoutMs: 100, maxResponseBytes: 1024 };
  for (const fetch of [
    async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } }),
    async () => json({ companies: { company: [{ dbNazev: '../admin' }] } }),
    async () => json({ companies: { company: [{ dbNazev: 'a' }, { dbNazev: 'a' }] } }),
    async () => new Response('x'.repeat(1025), { headers: { 'content-type': 'application/json' } }),
    async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }),
  ] satisfies FetchFunction[]) {
    const registry = new ConnectionRegistry({ ...base(), servers: [source] }, { fetch });
    await assert.rejects(registry.companies('north'));
  }
});

test('legacy single-company callers and injected clients remain compatible without catalogue requests', async () => {
  const legacy = loadConfig({ FLEXI_BASE_URL: 'https://north.example.test', FLEXI_COMPANY: 'a', FLEXI_USERNAME: 'reader', FLEXI_PASSWORD: 'secret' });
  let requested = false;
  const registry = new ConnectionRegistry(legacy, { fetch: async () => { requested = true; throw new Error('should not fetch'); } });
  assert.equal(registry.multi, false);
  assert.equal(registry.resolve().database, 'a');
  await registry.ensureReady(registry.resolve());
  assert.equal(requested, false);
  assert.throws(() => new ConnectionRegistry({ ...base(), flexi: { ...legacy.flexi!, baseUrl: 'https://north.example.test/path' } }), { code: 'INVALID_INPUT' });
});
