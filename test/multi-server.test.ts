import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import type { ServerConfig } from '../src/config.ts';
import { ConnectionRegistry } from '../src/connections.ts';
import { createServer } from '../src/server.ts';
import { LawService } from '../src/law/index.ts';
import type { AuditEvent } from '../src/audit.ts';

const json = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
async function fixture(options: { failAudit?: boolean; state?: string; failServer?: string } = {}) {
  const servers: ServerConfig[] = ['alpha', 'beta'].map(id => ({
    id, label: id, baseUrl: `https://${id}.example.test:5434`,
    credentials: { production: { username: `${id}-prod`, password: `PASSWORD-${id}-prod` }, test: { username: `${id}-test`, password: `PASSWORD-${id}-test` } },
    companies: [
      { id: 'production', label: `${id} Production`, database: 'same_database', credentialId: 'production', environment: 'production', allowedEvidences: ['*'] },
      { id: 'test', label: `${id} Test`, database: 'test_database', credentialId: 'test', environment: 'test', allowedEvidences: ['faktura-vydana'] },
    ], limits: { maxConcurrentRequests: 4, requestsPerMinute: 600 }, timeoutMs: 1000, maxResponseBytes: 1_048_576,
  }));
  const config = { ...loadConfig({}), servers, callsPerMinute: 600 };
  const urls: URL[] = [];
  const dataRequests: string[] = [];
  const events: AuditEvent[] = [];
  const registry = new ConnectionRegistry(config, { fetch: async (input, init) => {
    const url = new URL(String(input)); urls.push(url);
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
    const server = servers.find(s => s.baseUrl === url.origin)!;
    assert.ok(server);
    if (options.failServer === server.id) throw new Error('PASSWORD-private-upstream');
    const auth = new Headers(init?.headers).get('authorization');
    const credential = Object.entries(server.credentials).find(([, c]) => `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}` === auth);
    assert.ok(credential, 'wrong credentials for API origin');
    const isTest = credential[0] === 'test';
    if (url.pathname === '/c.json') {
      const start = Number(url.searchParams.get('start') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      return json({ companies: { company: [
      { id: '-2', dbNazev: 'same_database', nazev: `${server.id} Real Production`, show: 'true', stavEnum: options.state ?? 'ESTABLISHED' },
      { id: '-2', dbNazev: 'test_database', nazev: `${server.id} Real Test`, show: 'true', stavEnum: 'ESTABLISHED' },
      ].slice(start, start + limit) } });
    }
    const database = isTest ? 'test_database' : 'same_database';
    assert.ok(url.pathname.startsWith(`/c/${database}/`), 'request crossed database/profile boundary');
    if (url.pathname.endsWith('/evidence-list.json')) return json({ evidences: { evidence: [{ evidencePath: 'faktura-vydana', evidenceName: 'Invoices', evidenceType: 'INVOICE', evidenceAccess: 'true' }] } });
    if (url.pathname.endsWith('/properties.json')) return json({ properties: { property: [
      { propertyName: 'id', type: 'integer' }, { propertyName: 'kod', type: 'string' },
      { propertyName: server.id === 'alpha' ? 'alphaField' : 'betaField', type: 'string' },
    ] } });
    if (url.pathname.endsWith('/relations.json')) return json({ relations: {} });
    dataRequests.push(`${server.id}/${database}`);
    const start = Number(url.searchParams.get('start') ?? '0');
    return json({ winstrom: { '@rowCount': '2', 'faktura-vydana': [{ id: String(start + 1), kod: `${server.id}/${database}`, alphaField: 'ALPHA', betaField: 'BETA' }] } });
  } });
  const server = createServer(config, { registry, law: await LawService.create({}), audit: { async record(event) { if (options.failAudit) throw new Error('audit failed'); events.push(event); } } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'multi-server-integration', version: '1' });
  await client.connect(clientTransport);
  return { client, registry, urls, dataRequests, events, close: async () => { await client.close(); await server.close(); } };
}
const query = { evidence: 'faktura-vydana', fields: ['id', 'kod'], pageSize: 1 };

test('MCP routes concurrent requests across two servers and four companies with explicit response and audit origin', async () => {
  const peer = await fixture();
  try {
    const targets = ['alpha/production', 'alpha/test', 'beta/production', 'beta/test'];
    const results = await Promise.all(targets.map(target => peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, target } })));
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      assert.ok(!result.isError, JSON.stringify(result));
      const body = result.structuredContent as { data: { records: { kod: string }[] }; meta: { target: string; database: string; companyName: string; scope: string } };
      const target = targets[i]!;
      assert.equal(body.meta.target, target); assert.equal(body.meta.scope, 'company');
      assert.equal(body.data.records[0]?.kod, `${target.split('/')[0]}/${target.endsWith('test') ? 'test_database' : 'same_database'}`);
      assert.match(body.meta.companyName, /Real/);
      assert.ok(peer.events.some(e => e.target === target && e.database === body.meta.database && e.outcome === 'success'));
      assert.doesNotMatch(JSON.stringify(result), /PASSWORD-|Authorization|Basic /);
    }
    const tools = await peer.client.listTools(); assert.equal(tools.tools.length, 13);
    const catalog = await peer.client.callTool({ name: 'flexi_target_list', arguments: {} });
    assert.doesNotMatch(JSON.stringify(catalog), /PASSWORD-|username|password/);
    const firstPage = await peer.client.callTool({ name: 'flexi_target_list', arguments: { pageSize: 1 } });
    const page = firstPage.structuredContent as { data: { targets: { target: string }[]; nextCursor: string } };
    assert.equal(page.data.targets.length, 1); assert.ok(page.data.nextCursor);
    const nextPage = await peer.client.callTool({ name: 'flexi_target_list', arguments: { pageSize: 1, cursor: page.data.nextCursor } });
    assert.equal((nextPage.structuredContent as { data: { targets: { target: string }[] } }).data.targets[0]?.target, 'alpha/test');
    const info = await peer.client.callTool({ name: 'server_info', arguments: { target: 'alpha/production' } });
    assert.ok(!Object.hasOwn((info.structuredContent as { data: object }).data, 'targets'));
  } finally { await peer.close(); }
});

test('MCP missing or unknown target never falls back, including when other firms are not ready', async () => {
  const peer = await fixture({ state: 'ESTABLISHING' });
  try {
    const missing = await peer.client.callTool({ name: 'flexi_record_list', arguments: query });
    assert.equal(missing.isError, true); assert.match(JSON.stringify(missing), /TARGET_REQUIRED/);
    assert.equal(peer.urls.length, 0);
    const unknown = await peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, target: 'alpha/unknown' } });
    assert.equal(unknown.isError, true); assert.match(JSON.stringify(unknown), /TARGET_NOT_FOUND/);
    assert.equal(peer.urls.length, 0);
    const notReady = await peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, target: 'alpha/production' } });
    assert.equal(notReady.isError, true); assert.match(JSON.stringify(notReady), /COMPANY_NOT_READY/);
    assert.equal((notReady.structuredContent as { meta: { target: string } }).meta.target, 'alpha/production');
    assert.equal(peer.dataRequests.length, 0);
    for (const target of ['https://evil.test', '../production', 'alpha%2ftest']) {
      assert.equal((await peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, target } })).isError, true);
    }
  } finally { await peer.close(); }
});

test('MCP company and credential discovery requires unambiguous profiles and preserves pagination scope', async () => {
  const peer = await fixture();
  try {
    const ambiguous = await peer.client.callTool({ name: 'flexi_company_list', arguments: { serverId: 'alpha' } });
    assert.equal(ambiguous.isError, true); assert.equal(peer.urls.length, 0);
    const first = await peer.client.callTool({ name: 'flexi_company_list', arguments: { serverId: 'alpha', credentialId: 'production' } });
    assert.ok(!first.isError);
    const body = first.structuredContent as { data: { companies: { database: string }[] }; meta: { scope: string; serverId: string } };
    assert.equal(body.data.companies[0]?.database, 'same_database');
    assert.equal(body.meta.scope, 'server'); assert.equal(body.meta.serverId, 'alpha');
    const paged = { serverId: 'alpha', credentialId: 'production', pageSize: 1 };
    const page = await peer.client.callTool({ name: 'flexi_company_list', arguments: paged });
    const cursor = (page.structuredContent as { data: { nextCursor: string } }).data.nextCursor;
    assert.ok(cursor);
    const next = await peer.client.callTool({ name: 'flexi_company_list', arguments: { ...paged, cursor } });
    assert.ok(!next.isError);
    assert.equal((next.structuredContent as { data: { companies: { database: string }[] } }).data.companies[0]?.database, 'test_database');
    const count = peer.urls.length;
    for (const changed of [{ serverId: 'beta' }, { credentialId: 'test' }]) {
      const replay = await peer.client.callTool({ name: 'flexi_company_list', arguments: { ...paged, ...changed, cursor } });
      assert.equal(replay.isError, true); assert.match(JSON.stringify(replay), /INVALID_CURSOR/);
    }
    assert.equal(peer.urls.length, count);
  } finally { await peer.close(); }
});

test('MCP cursors and schema caches cannot cross servers or mix wildcard and restricted company policy', async () => {
  const peer = await fixture();
  try {
    const first = await peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, target: 'alpha/production' } });
    const cursor = (first.structuredContent as { data: { nextCursor: string } }).data.nextCursor;
    assert.ok(cursor);
    for (const target of ['beta/production', 'alpha/test']) {
      const count = peer.dataRequests.length;
      const replay = await peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, target, cursor } });
      assert.equal(replay.isError, true); assert.match(JSON.stringify(replay), /INVALID_CURSOR/);
      assert.equal(peer.dataRequests.length, count);
    }
    const right = await peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, target: 'alpha/production', cursor } }); assert.ok(!right.isError);
    const alpha = await peer.client.callTool({ name: 'flexi_schema_get', arguments: { target: 'alpha/production', evidence: 'faktura-vydana' } });
    const beta = await peer.client.callTool({ name: 'flexi_schema_get', arguments: { target: 'beta/production', evidence: 'faktura-vydana' } });
    assert.match(JSON.stringify(alpha), /alphaField/); assert.doesNotMatch(JSON.stringify(beta), /alphaField/);
    const denied = await peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, target: 'alpha/test', fields: ['alphaField'] } });
    assert.equal(denied.isError, true); assert.match(JSON.stringify(denied), /INVALID_INPUT/);
    assert.equal((await peer.client.callTool({ name: 'flexi_relations_get', arguments: { target: 'alpha/test', evidence: 'faktura-vydana' } })).isError, true);
    const info = await peer.client.callTool({ name: 'server_info', arguments: { target: 'alpha/test' } });
    const caps = (info.structuredContent as { data: { maxFields: number; discoveryTools: string[] } }).data;
    assert.equal(caps.maxFields, 20); assert.deepEqual(caps.discoveryTools, ['flexi_schema_get']);
  } finally { await peer.close(); }
});

test('MCP audit failure prevents discovery and data; server failure preserves other targets and public law tools', async () => {
  const closed = await fixture({ failAudit: true });
  try {
    const result = await closed.client.callTool({ name: 'flexi_record_list', arguments: { ...query, target: 'alpha/production' } });
    assert.equal(result.isError, true); assert.match(JSON.stringify(result), /AUDIT_UNAVAILABLE/);
    assert.equal(closed.urls.length, 0);
  } finally { await closed.close(); }
  const peer = await fixture({ failServer: 'alpha' });
  try {
    const failed = await peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, target: 'alpha/production' } });
    assert.equal(failed.isError, true); assert.doesNotMatch(JSON.stringify(failed), /PASSWORD-private-upstream/);
    assert.equal((failed.structuredContent as { meta: { target: string } }).meta.target, 'alpha/production');
    assert.ok(!(await peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, target: 'beta/production' } })).isError);
    assert.ok(!(await peer.client.callTool({ name: 'czlaw_status', arguments: {} })).isError);
    const info = await peer.client.callTool({ name: 'server_info', arguments: {} });
    assert.ok(!info.isError); assert.doesNotMatch(JSON.stringify(info), /PASSWORD-|Basic /);
    const resource = await peer.client.readResource({ uri: 'flexi://capabilities' });
    assert.match(JSON.stringify(resource), /alpha\/production/);
    await assert.rejects(peer.client.getPrompt({ name: 'accounting_review', arguments: { regime: 'accounting', asOf: '2026-10-26' } }));
  } finally { await peer.close(); }
});
