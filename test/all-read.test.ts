import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';
import { LawService } from '../src/law/index.ts';
import { FlexiClient } from '../src/flexi/client.ts';
import { compileFilters } from '../src/flexi/policy.ts';
import { parseEvidences, parseProperties, parseRelations } from '../src/flexi/metadata.ts';

const env = { FLEXI_BASE_URL: 'https://flexi.example.test:5434', FLEXI_COMPANY: 'demo', FLEXI_USERNAME: 'reader', FLEXI_PASSWORD: 'secret', FLEXI_ALLOWED_EVIDENCES: '*' };
const config = loadConfig(env);
const catalog = { evidences: { evidence: [
  { evidencePath: 'faktura-prijata', evidenceName: 'Přijaté faktury', evidenceType: 'INVOICE', evidenceAccess: 'true' },
  { evidencePath: 'faktura-prijata-polozka', evidenceName: 'Položky', evidenceType: 'ITEM', evidenceAccess: 'true' },
  { evidencePath: 'ucetni-denik', evidenceName: 'Účetní deník', evidenceType: 'JOURNAL', evidenceAccess: 'true' },
  { evidencePath: 'banka', evidenceType: 'BANK', evidenceAccess: 'false' },
  { evidencePath: 'global-store', evidenceType: 'STORE', evidenceAccess: 'true' },
] } };
const schema = { properties: { property: [
  { propertyName: 'id', type: 'integer', inId: 'true' },
  { propertyName: 'nazFirmy', type: 'string', title: 'Dodavatel' },
  { propertyName: 'dic', type: 'string' },
  { propertyName: 'sumDphZakl', type: 'numeric' },
  { propertyName: 'ucetni', type: 'logic' },
  { propertyName: 'lastUpdate', type: 'datetime' },
  { propertyName: 'postingPeriod', type: 'yearMonth' },
  { propertyName: 'idPolozek', type: 'array' },
  { propertyName: 'clenDph', type: 'relation', fkEvidencePath: 'cleneni-dph', url: 'https://attacker.test' },
  { propertyName: 'heslo', type: 'string' },
  { propertyName: 'apiToken', type: 'string' },
  { propertyName: 'obsah', type: 'string' },
] } };
const relations = { relations: { relation: [{ url: 'polozkyDokladu', evidenceType: 'ITEM', name: 'Položky faktur' }, { url: 'secretStore', evidenceType: 'STORE', name: 'Secrets' }] } };
const data = { id: '42', nazFirmy: 'Google Ireland', dic: 'IE123', sumDphZakl: '125.05', ucetni: true, lastUpdate: '2026-01-01T12:00:00Z', postingPeriod: '2026-01', idPolozek: ['5', '6'], clenDph: 'code:REVERSE', 'clenDph@showAs': 'Reverse charge', 'clenDph@internalId': '7', 'clenDph@ref': 'https://evil.test', heslo: 'must-not-leak', extra: 'must-not-leak' };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function setup(record: unknown = data) {
  const requests: URL[] = [];
  const flexi = new FlexiClient(config.flexi!, async (input, init) => {
    assert.equal(init?.method, 'GET');
    const url = new URL(String(input)); requests.push(url);
    assert.equal(url.origin, env.FLEXI_BASE_URL);
    if (url.pathname.endsWith('/evidence-list.json')) return json(catalog);
    if (url.pathname.endsWith('/properties.json')) return json(schema);
    if (url.pathname.endsWith('/relations.json')) return json(relations);
    const target = url.pathname.includes('polozkyDokladu') ? 'faktura-prijata-polozka' : 'faktura-prijata';
    return json({ winstrom: { '@rowCount': '3', [target]: [record] } });
  });
  return { flexi, requests };
}

test('all-read discovers role-scoped registers and complete schema without credential fields or URLs', async () => {
  const { flexi, requests } = setup();
  const evidences = await flexi.evidences();
  assert.equal(evidences.find(e => e.evidence === 'banka')?.access, false);
  assert.equal(evidences.find(e => e.evidence === 'global-store')?.access, false);
  const properties = (await flexi.schema('faktura-prijata')).properties;
  assert.equal(properties.find(p => p.name === 'nazFirmy')?.label, 'Dodavatel');
  assert.equal(properties.find(p => p.name === 'clenDph')?.referenceEvidence, 'cleneni-dph');
  assert.ok(!properties.some(p => /heslo|Token|obsah/.test(p.name)));
  assert.doesNotMatch(JSON.stringify(properties), /attacker/);
  properties[0]!.name = 'changed';
  assert.equal((await flexi.schema('faktura-prijata')).properties[0]?.name, 'id');
  assert.equal(requests.length, 2);
});

test('dynamic fields support VAT, booleans, reference labels and exact decimals with bounded projection', async () => {
  const { flexi, requests } = setup();
  const fields = ['id', 'nazFirmy', 'dic', 'sumDphZakl', 'ucetni', 'clenDph', 'postingPeriod', 'idPolozek'];
  const result = await flexi.listRecords({ evidence: 'faktura-prijata', fields, limit: 1, filters: [{ field: 'nazFirmy', op: 'contains', value: 'Google' }, { field: 'ucetni', op: 'eq', value: 'true' }] });
  assert.equal(result.records[0]?.sumDphZakl, '125.05');
  assert.equal(result.records[0]?.ucetni, true);
  assert.deepEqual(result.records[0]?.idPolozek, ['5', '6']);
  assert.equal(result.records[0]?.['clenDph@internalId'], '7');
  assert.doesNotMatch(JSON.stringify(result), /evil|must-not-leak/);
  assert.match(decodeURIComponent(requests.at(-1)!.pathname), /nazFirmy like 'Google' and ucetni eq true/);
  assert.equal(requests.at(-1)!.searchParams.get('use-internal-id'), 'true');
  for (const record of [{ ...data, sumDphZakl: 125.05 }, { ...data, idPolozek: [{ secret: 'nested' }] }, { ...data, ucetni: 'maybe' }]) {
    await assert.rejects(setup(record).flexi.listRecords({ evidence: 'faktura-prijata', fields }), { code: 'INVALID_RESPONSE' });
  }
});

test('broad mode rejects operations, unknown evidence, denied roles and credential fields', async () => {
  const { flexi, requests } = setup();
  for (const evidence of ['../admin', 'faktura-prijata/42', 'https://evil.test', 'ucetni-obdobi/inicializace-noveho-obdobi', 'global-store']) {
    await assert.rejects(flexi.listRecords({ evidence, fields: ['id'] }), { code: 'INVALID_INPUT' });
  }
  assert.equal(requests.length, 0);
  for (const evidence of ['banka', 'unknown']) await assert.rejects(flexi.schema(evidence), { code: 'INVALID_INPUT' });
  assert.equal(requests.length, 1);
  for (const fields of [['heslo'], ['apiToken'], ['notInSchema'], ['clenDph@ref'], ['id', 'id']]) {
    await assert.rejects(flexi.listRecords({ evidence: 'faktura-prijata', fields }), { code: 'INVALID_INPUT' });
  }
  assert.equal(requests.length, 2);
});

test('child relations resolve their actual evidence and cannot select an arbitrary path or target', async () => {
  const { flexi, requests } = setup();
  assert.deepEqual(await flexi.relations('faktura-prijata'), [{ name: 'polozkyDokladu', label: 'Položky faktur', evidence: 'faktura-prijata-polozka' }]);
  const input = { evidence: 'faktura-prijata', id: '42', relation: 'polozkyDokladu', fields: ['id'], limit: 1 };
  assert.deepEqual((await flexi.listRelation(input)).records, [{ id: '42' }]);
  assert.equal(requests.at(-1)!.pathname, '/c/demo/faktura-prijata/42/polozkyDokladu.json');
  const count = requests.length;
  for (const relation of ['../admin', 'secretStore', 'unknown']) await assert.rejects(flexi.listRelation({ ...input, relation }), { code: 'INVALID_INPUT' });
  assert.equal(requests.length, count);
});

test('metadata rejects duplicates, malicious identifiers and ambiguous relation targets', () => {
  assert.throws(() => parseEvidences({ evidences: { evidence: [{ evidencePath: '../admin' }] } }));
  assert.throws(() => parseProperties({ properties: { property: [{ propertyName: 'id', type: 'integer' }, { propertyName: 'id', type: 'integer' }] } }));
  assert.throws(() => parseRelations({ relations: { relation: [{ url: 'x/y' }] } }, []));
  const duplicateTargets = [...parseEvidences(catalog), { evidence: 'another-item', evidenceType: 'ITEM', access: true, name: '', importStatus: '' }];
  assert.deepEqual(parseRelations(relations, duplicateTargets), []);
  assert.throws(() => compileFilters('anything', [{ field: 'ucetni', op: 'eq', value: 'true or id gt 0' }], { ucetni: 'boolean' }));
  assert.throws(() => compileFilters('anything', [{ field: 'lastUpdate', op: 'eq', value: '2026-02-30T12:00:00' }], { lastUpdate: 'datetime' }));
  assert.deepEqual(parseRelations({ relations: {} }, []), []);
  assert.equal(compileFilters('anything', [{ field: 'integer', op: 'eq', value: '-1' }], { integer: 'integer' }), 'integer eq -1');
  assert.deepEqual(parseProperties({ properties: { property: [{ propertyName: 'id', type: 'integer' }, { propertyName: 'bad', type: 'constructor' }] } }).map(p => p.name), ['id']);
});

test('journal identity aliases and native enum values are usable without assuming every register has id', async () => {
  const urls: URL[] = [];
  const properties = { properties: { property: [
    { propertyName: 'idUcetniDenik', type: 'integer' },
    { propertyName: 'modulK', type: 'select', values: { value: [{ '@key': 'modulUcetni.FAP', '$': 'Faktury přijaté' }] } },
    { propertyName: 'sumTuz', type: 'numeric' },
  ] } };
  const flexi = new FlexiClient(config.flexi!, async input => {
    const url = new URL(String(input)); urls.push(url);
    if (url.pathname.endsWith('evidence-list.json')) return json(catalog);
    if (url.pathname.endsWith('properties.json')) return json(properties);
    return json({ winstrom: { 'ucetni-denik': [{ idUcetniDenik: '123', modulK: 'modulUcetni.FAP', sumTuz: '10.05' }] } });
  });
  const first = await flexi.schema('ucetni-denik');
  assert.equal(first.properties[1]?.values?.[0]?.value, 'modulUcetni.FAP');
  first.properties[1]!.values![0]!.value = 'corrupted';
  assert.equal((await flexi.schema('ucetni-denik')).properties[1]?.values?.[0]?.value, 'modulUcetni.FAP');
  const result = await flexi.getRecord({ evidence: 'ucetni-denik', id: '123', fields: ['sumTuz'] });
  assert.deepEqual(result.records, [{ sumTuz: '10.05' }]);
  assert.equal(urls.at(-1)!.searchParams.get('order'), 'idUcetniDenik');
  await flexi.listRecords({ evidence: 'ucetni-denik', fields: ['modulK'], filters: [{ field: 'modulK', op: 'eq', value: 'modulUcetni.FAP' }] });
  assert.equal(urls.at(-1)!.searchParams.get('order'), 'idUcetniDenik');
});

test('MCP broad-mode discovery and relation pagination use strict schemas and bind cursors to parents', async () => {
  const { flexi } = setup();
  const server = createServer(config, { flexi, law: await LawService.create({}), audit: { async record() {} } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'all-read-test', version: '1' });
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 10);
    for (const tool of tools.tools) assert.equal(tool.inputSchema.additionalProperties, false);
    const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const catalogResult = await call('flexi_evidence_list', { query: 'deník' });
    assert.match(JSON.stringify(catalogResult), /ucetni-denik/);
    const query = { evidence: 'faktura-prijata', id: '42', relation: 'polozkyDokladu', fields: ['id'], pageSize: 1 };
    const first = await call('flexi_relation_list', query);
    assert.ok(!first.isError);
    const result = first.structuredContent as { data: { nextCursor: string } };
    assert.ok(result.data.nextCursor);
    assert.ok(!(await call('flexi_relation_list', { ...query, cursor: result.data.nextCursor })).isError);
    const wrongParent = await call('flexi_relation_list', { ...query, id: '43', cursor: result.data.nextCursor });
    assert.equal(wrongParent.isError, true);
    assert.match(JSON.stringify(wrongParent), /INVALID_CURSOR/);
  } finally { await client.close(); await server.close(); }
});
