import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { FlexiClient } from '../src/flexi/client.ts';
import { LawService } from '../src/law/index.ts';
import { createServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import type { AuditEvent, AuditSink } from '../src/audit.ts';

const config = loadConfig({ FLEXI_BASE_URL: 'https://flexi.example:5434', FLEXI_COMPANY: 'tenant_a', FLEXI_USERNAME: 'api', FLEXI_PASSWORD: 'top-secret' });
const body = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });

async function connect(options: { failAudit?: boolean; failFetch?: boolean; callsPerMinute?: number } = {}) {
  const events: AuditEvent[] = [];
  const urls: string[] = [];
  const audit: AuditSink = { async record(event) { if (options.failAudit) throw new Error('private audit error'); events.push(event); } };
  const flexi = new FlexiClient(config.flexi!, async input => {
    const url = new URL(String(input)); urls.push(url.href);
    if (options.failFetch) throw new Error('top-secret https://private.upstream/ payroll=hidden');
    if (url.pathname.endsWith('/properties.json')) return body({ properties: { property: [{ propertyName: 'id' }, { propertyName: 'kod' }] } });
    const start = Number(url.searchParams.get('start') ?? 0);
    return body({ winstrom: { '@rowCount': '3', 'faktura-vydana': start === 0 ? [{ id: '1', kod: 'FV1', password: 'secret-should-not-leak' }] : [{ id: '2', kod: 'FV2' }] } });
  });
  const server = createServer({ ...config, ...(options.callsPerMinute ? { callsPerMinute: options.callsPerMinute } : {}) }, { audit, flexi, law: await LawService.create({}) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, events, urls, close: async () => { await client.close(); await server.close(); } };
}

test('official MCP SDK discovers strict read-only tools, resources and prompt', async () => {
  const peer = await connect();
  try {
    const catalog = await peer.client.listTools();
    assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), ['czlaw_provision_get', 'czlaw_search', 'czlaw_status', 'flexi_record_get', 'flexi_record_list', 'flexi_schema_get', 'server_info']);
    for (const tool of catalog.tools) { assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.inputSchema.additionalProperties, false); assert.ok(tool.outputSchema); }
    assert.equal((await peer.client.listResources()).resources.length, 2);
    assert.equal((await peer.client.listPrompts()).prompts[0]?.name, 'accounting_review');
    const resource = await peer.client.readResource({ uri: 'czlaw://status' });
    assert.match(JSON.stringify(resource), /not_ready/);
    const prompt = await peer.client.getPrompt({ name: 'accounting_review', arguments: { regime: 'accounting', asOf: '2026-10-26' } });
    assert.match(JSON.stringify(prompt.messages), /withhold a definitive legal conclusion/);
  } finally { await peer.close(); }
});

test('MCP query projects output and opaque cursor is bound to its query', async () => {
  const peer = await connect();
  try {
    const query = { evidence: 'faktura-vydana', fields: ['id', 'kod'], pageSize: 1 };
    const first = await peer.client.callTool({ name: 'flexi_record_list', arguments: query });
    assert.equal(first.isError, undefined);
    const result = first.structuredContent as { data: { nextCursor: string; records: unknown[] } };
    assert.deepEqual(result.data.records, [{ id: '1', kod: 'FV1' }]);
    assert.ok(result.data.nextCursor);
    const next = await peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, cursor: result.data.nextCursor } });
    assert.equal(next.isError, undefined);
    assert.match(peer.urls.at(-1)!, /start=1/);
    const count = peer.urls.length;
    const stolen = await peer.client.callTool({ name: 'flexi_record_list', arguments: { ...query, fields: ['kod'], cursor: result.data.nextCursor } });
    assert.equal(stolen.isError, true);
    assert.match(JSON.stringify(stolen), /INVALID_CURSOR/);
    assert.equal(peer.urls.length, count);
    assert.doesNotMatch(JSON.stringify(first), /secret-should-not-leak/);
  } finally { await peer.close(); }
});

test('SDK rejects extra URL/method/company arguments, invalid limit and forbidden evidence before fetch', async () => {
  const peer = await connect();
  try {
    for (const extra of [{ url: 'https://attacker.test/' }, { company: 'tenant_b' }, { method: 'DELETE' }, { pageSize: 0 }, { evidence: 'ucetni-obdobi/inicializace-noveho-obdobi' }]) {
      const result = await peer.client.callTool({ name: 'flexi_record_list', arguments: { evidence: 'faktura-vydana', fields: ['id'], ...extra } });
      assert.equal(result.isError, true);
    }
    assert.deepEqual(peer.urls, []);
  } finally { await peer.close(); }
});

test('upstream errors are sanitized and audit contains metadata rather than arguments', async () => {
  const peer = await connect({ failFetch: true });
  try {
    const result = await peer.client.callTool({ name: 'flexi_record_list', arguments: { evidence: 'faktura-vydana', fields: ['id'], filters: [{ field: 'kod', op: 'eq', value: 'PRIVATE-INVOICE' }] } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /top-secret|private\.upstream|payroll/);
    assert.equal(peer.events.length, 2);
    assert.equal(peer.events[1]?.outcome, 'error');
    assert.doesNotMatch(JSON.stringify(peer.events), /PRIVATE-INVOICE|top-secret|filters|private\.upstream/);
  } finally { await peer.close(); }
});

test('audit failure blocks upstream access', async () => {
  const peer = await connect({ failAudit: true });
  try {
    const result = await peer.client.callTool({ name: 'flexi_record_list', arguments: { evidence: 'faktura-vydana', fields: ['id'] } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /AUDIT_UNAVAILABLE/);
    assert.deepEqual(peer.urls, []);
  } finally { await peer.close(); }
});

test('unconfigured legal search refuses normative output and accepts only categorical inputs', async () => {
  const peer = await connect();
  try {
    const args = { asOf: '2026-10-26', regime: 'tax_evidence', topics: ['income_tax'] };
    const result = await peer.client.callTool({ name: 'czlaw_search', arguments: args });
    const data = (result.structuredContent as { data: { status: string; fragments: unknown[] } }).data;
    assert.equal(data.status, 'not_ready'); assert.deepEqual(data.fragments, []);
    const injected = await peer.client.callTool({ name: 'czlaw_search', arguments: { ...args, invoice: 'customer and amounts' } });
    assert.equal(injected.isError, true);
    assert.deepEqual(peer.urls, []);
  } finally { await peer.close(); }
});

test('local quota stops further operations', async () => {
  const peer = await connect({ callsPerMinute: 1 });
  try {
    await peer.client.callTool({ name: 'czlaw_status', arguments: {} });
    const result = await peer.client.callTool({ name: 'server_info', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /RATE_LIMITED/);
  } finally { await peer.close(); }
});
