import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { ConnectionRegistry } from '../src/connections.ts';
import type { ServerConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';
import { LawService } from '../src/law/index.ts';
import type { InvoiceWriteService } from '../src/writes.ts';
import type { AuditEvent } from '../src/audit.ts';

const intentId = 'abf87108-ecc5-4074-827e-ae65109a260f';
async function fixture(options: { audit?: 'before' | 'after'; unknown?: boolean } = {}) {
  const source: ServerConfig = {
    id: 'mock', label: 'Mock', baseUrl: 'https://never-contacted.example.test', credentials: { reader: { username: 'reader', password: 'fixture-secret' } },
    companies: [{ id: 'production', label: 'Production', database: 'production', credentialId: 'reader', environment: 'production', allowedEvidences: ['*'], writePolicy: { enabled: true, headerFields: ['clenDph'], itemFields: ['clenDph'] } }],
    limits: { maxConcurrentRequests: 4, requestsPerMinute: 60 }, timeoutMs: 100, maxResponseBytes: 1024,
  };
  const config = { ...loadConfig({}), servers: [source] };
  const registry = new ConnectionRegistry(config, { fetch: async () => { throw new Error('No upstream request expected in SDK-boundary test'); } });
  const calls: { operation: string; target: string; id?: string }[] = [];
  const events: AuditEvent[] = [];
  const writes = {
    async prepare(input: { target: string }) { calls.push({ operation: 'prepare', target: input.target }); return { id: intentId, target: input.target, status: 'prepared', digest: 'a'.repeat(64) }; },
    async status(target: string, id: string) { calls.push({ operation: 'status', target, id }); return { id, target, status: 'prepared' }; },
    async commit(target: string, id: string) { calls.push({ operation: 'commit', target, id }); return { id, target, status: options.unknown ? 'unknown' : 'succeeded', code: options.unknown ? 'WRITE_UNKNOWN' : undefined }; },
  } as unknown as InvoiceWriteService;
  const server = createServer(config, { registry, writes, law: await LawService.create({}), audit: { async record(event) {
    if (options.audit === 'before' || (options.audit === 'after' && calls.some(call => call.operation === 'commit'))) throw new Error('Audit failure');
    events.push(event);
  } } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); await server.connect(serverTransport);
  const client = new Client({ name: 'write-sdk-test', version: '1' }); await client.connect(clientTransport);
  return { client, calls, events, close: async () => { await client.close(); await server.close(); } };
}

test('SDK exposes explicit invoice prepare/status/commit with correct mutation annotations and metadata', async () => {
  const f = await fixture();
  try {
    const tools = (await f.client.listTools()).tools; assert.equal(tools.length, 16);
    assert.equal(tools.find(tool => tool.name === 'flexi_invoice_update_commit')?.annotations?.readOnlyHint, false);
    assert.equal(tools.find(tool => tool.name === 'flexi_invoice_update_commit')?.annotations?.idempotentHint, false);
    assert.equal(tools.find(tool => tool.name === 'flexi_invoice_update_status')?.annotations?.readOnlyHint, true);
    const prepared = await f.client.callTool({ name: 'flexi_invoice_update_prepare', arguments: { target: 'mock/production', invoiceId: '45', expectedCode: 'TEST-PF-0001', headerPatch: { clenDph: 'code:EU' } } });
    assert.ok(!prepared.isError); assert.equal((prepared.structuredContent as { meta: { readOnly: boolean } }).meta.readOnly, false);
    const result = await f.client.callTool({ name: 'flexi_invoice_update_commit', arguments: { target: 'mock/production', intentId } });
    assert.ok(!result.isError); assert.equal((result.structuredContent as { meta: { target: string } }).meta.target, 'mock/production');
    const status = await f.client.callTool({ name: 'flexi_invoice_update_status', arguments: { target: 'mock/production', intentId } });
    assert.ok(!status.isError); assert.equal((status.structuredContent as { meta: { readOnly: boolean } }).meta.readOnly, true);
    assert.ok(f.events.some(event => event.operation === 'flexi_invoice_update_commit' && event.readOnly === false));
    const info = await f.client.callTool({ name: 'server_info', arguments: {} });
    assert.equal((info.structuredContent as { data: { readOnly: boolean } }).data.readOnly, false);
    assert.doesNotMatch(JSON.stringify(info), /fixture-secret/);
  } finally { await f.close(); }
});

test('SDK write boundary rejects missing target and replacement payload/approval flags before service invocation', async () => {
  const f = await fixture();
  try {
    for (const extra of [{ approved: true }, { headerPatch: { clenDph: 'code:OTHER' } }, { url: 'https://evil.test' }, { target: 'mock/other' }]) {
      const result = await f.client.callTool({ name: 'flexi_invoice_update_commit', arguments: { target: 'mock/production', intentId, ...extra } }); assert.equal(result.isError, true);
    }
    assert.equal((await f.client.callTool({ name: 'flexi_invoice_update_commit', arguments: { intentId } })).isError, true);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('SDK unknown write completion is an error with persisted state, and audit failure never implies no mutation after dispatch', async () => {
  const unknown = await fixture({ unknown: true });
  try {
    const result = await unknown.client.callTool({ name: 'flexi_invoice_update_commit', arguments: { target: 'mock/production', intentId } });
    assert.equal(result.isError, true); assert.equal((result.structuredContent as { data: { status: string } }).data.status, 'unknown');
    assert.ok(unknown.events.some(event => event.outcome === 'error' && event.code === 'WRITE_NOT_VERIFIED'));
  } finally { await unknown.close(); }
  for (const stage of ['before', 'after'] as const) {
    const f = await fixture({ audit: stage });
    try {
      const result = await f.client.callTool({ name: 'flexi_invoice_update_commit', arguments: { target: 'mock/production', intentId } });
      assert.equal(result.isError, true);
      assert.equal(f.calls.filter(call => call.operation === 'commit').length, stage === 'before' ? 0 : 1);
      assert.match(JSON.stringify(result), stage === 'before' ? /AUDIT_UNAVAILABLE/ : /WRITE_AUDIT_UNAVAILABLE/);
    } finally { await f.close(); }
  }
});
