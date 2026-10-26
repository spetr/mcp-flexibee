import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { ConnectionRegistry } from '../src/connections.ts';
import type { AppConfig, ServerConfig } from '../src/config.ts';
import { InvoiceWriteService } from '../src/writes.ts';
import type { InvoiceWriteInput } from '../src/writes.ts';
import { IntentStore, signApproval, proposalDigest, canonicalJson } from '../src/write-store.ts';
import type { IntentView } from '../src/writes.ts';
import { buildExistingInvoicePayload } from '../src/flexi/client.ts';

const OLD = '2026-10-26T12:00:00+01:00';
const NEW = '2026-10-26T12:01:00+01:00';
const code = 'TEST-PF-0001';
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const prop = (propertyName: string, type: string, writable = false) => ({ propertyName, type, isWritable: String(writable) });
const success = () => ({ winstrom: { '@version': '1.0', success: 'true', stats: { created: '0', updated: '3', deleted: '0', skipped: '0', failed: '0' }, results: [{ id: '45', ref: '/ignored' }] } });

async function setup(options: { fault?: 'disconnect' | 'server' | 'conflict' | 'verify' | 'ledger' | 'dryWarning' | 'dryCreate' | 'wrongReceipt' | 'money' | 'dryNoContent' | 'commitWarning'; writable?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'flexi-writes-test-'));
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPath = join(dir, 'operator.pub');
  await writeFile(publicKeyPath, keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
  const writePolicy = { enabled: true, headerFields: ['clenDph', 'popis'], itemFields: ['clenDph', 'zklMdUcet', 'mnozMj'] };
  const server: ServerConfig = { id: 'mock', label: 'Mock', baseUrl: 'https://mock.example.test', credentials: { reader: { username: 'operator', password: 'mock-secret' } },
    companies: ['a', 'b'].map(id => ({ id, label: id, database: id, credentialId: 'reader', environment: 'test' as const, allowedEvidences: ['*'], writePolicy })),
    timeoutMs: 200, maxResponseBytes: 1_048_576, limits: { maxConcurrentRequests: 4, requestsPerMinute: 600 },
  };
  const config: AppConfig & { writeStorePath: string; writeApprovalPublicKeyPath: string } = { connectionName: 'main', auditPath: join(dir, 'audit'), callsPerMinute: 600, corpusMaxAgeDays: 7, servers: [server], writeStorePath: join(dir, 'store'), writeApprovalPublicKeyPath: publicKeyPath };
  const state = {
    invoice: { id: '45', kod: code, lastUpdate: OLD, clenDph: 'code:OLD', popis: 'Before', sumZklCelkem: '100.00', sumDphCelkem: '21.00', sumCelkem: '100.00' } as Record<string, unknown>,
    items: ['11', '12'].map(id => ({ id, lastUpdate: OLD, doklFak: `code:${code}`, 'doklFak@internalId': '45', clenDph: 'code:OLD', zklMdUcet: 'code:548', mnozMj: '1.00', sumZkl: id === '11' ? '100.00' : '0.00', sumDph: id === '11' ? '21.00' : '0.00', sumCelkem: id === '11' ? '121.00' : '0.00' }) as Record<string, unknown>),
    ledger: [false, true].map(vatItem => ({ idUcetniDenik: vatItem ? '2' : '1', idDokl: '45', modulK: 'modulUcetni.FAP', mdUcet: 'code:343', dalUcet: 'code:343', sumTuz: '21.00', sumMen: '0.00', typSzbDphK: 'typSzbDph.dphZakl', szbDph: '21.0', vatItem, zuctovano: true, clenDph: 'code:OLD' }) as Record<string, unknown>),
    dryRuns: 0, writes: 0, puts: [] as { url: URL; body: Record<string, unknown> }[],
  };
  let store: IntentStore;
  let onWrite: (() => Promise<void>) | undefined;
  let onRead: (() => Promise<void>) | undefined;
  const registry = new ConnectionRegistry(config, { fetch: async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, server.baseUrl);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Basic ' + Buffer.from('operator:mock-secret').toString('base64'));
    if (init?.method === 'PUT') {
      assert.equal(url.pathname, '/c/a/faktura-prijata/45.json');
      assert.equal(url.searchParams.get('as-gui'), 'true');
      assert.equal(url.searchParams.get('fail-on-warning'), 'true');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.puts.push({ url, body });
      const invoice = (body.winstrom as Record<string, unknown>)['faktura-prijata'] as Record<string, unknown>[];
      const update = invoice[0]!;
      assert.equal(update['@create'], 'fail'); assert.equal(update['@update'], 'ok'); assert.equal(update.id, '45');
      const items = update.polozkyDokladu as Record<string, unknown>[];
      assert.equal(items.length, 2, 'CAS guards cover all existing items');
      for (const item of items) { assert.equal(item['@create'], 'fail'); assert.equal(item['@update'], 'ok'); }
      if (url.searchParams.get('dry-run') === 'true') {
        state.dryRuns++;
        if (options.fault === 'dryWarning') return json({ winstrom: { ...success().winstrom, warnings: [{ code: 'mock.warning' }] } });
        if (options.fault === 'dryCreate') return json({ winstrom: { ...success().winstrom, stats: { ...success().winstrom.stats, created: '1' } } });
        if (options.fault === 'dryNoContent') return json(success());
        const calculated = structuredClone(state.invoice);
        const children = structuredClone(state.items);
        for (const [field, value] of Object.entries(update)) if (!field.startsWith('@') && !field.includes('@') && !['id', 'lastUpdate', 'polozkyDokladu'].includes(field)) calculated[field] = value;
        calculated.lastUpdate = NEW;
        for (const item of items) {
          const row = children.find(row => row.id === item.id)!;
          for (const [field, value] of Object.entries(item)) if (!field.startsWith('@') && !field.includes('@') && !['id', 'lastUpdate'].includes(field)) row[field] = value;
          if (update.clenDph) row.clenDph = update.clenDph;
          row.lastUpdate = NEW;
        }
        calculated.polozkyFaktury = children;
        calculated['@GUI'] = 'untrusted-gui-attribute'; calculated['id@ref'] = 'https://ignored-untrusted-reference';
        return json({ winstrom: { ...success().winstrom, results: [{ id: '45', content: { 'faktura-prijata': calculated } }] } });
      }
      state.writes++;
      await onWrite?.();
      if (options.fault === 'conflict') return json({ winstrom: { success: 'false' } }, 409);
      if (options.fault === 'server') return json({}, 503);
      if (update.lastUpdate !== state.invoice.lastUpdate || items.some(item => item.lastUpdate !== state.items.find(existing => existing.id === item.id)?.lastUpdate)) return json({}, 409);
      for (const [field, value] of Object.entries(update)) if (!field.startsWith('@') && !field.includes('@') && !['id', 'lastUpdate', 'polozkyDokladu'].includes(field)) state.invoice[field] = value;
      state.invoice.lastUpdate = NEW;
      for (const item of items) {
        const existing = state.items.find(existing => existing.id === item.id)!;
        for (const [field, value] of Object.entries(item)) if (!field.startsWith('@') && !field.includes('@') && !['id', 'lastUpdate'].includes(field)) existing[field] = value;
        existing.lastUpdate = NEW;
        if (update.clenDph) existing.clenDph = update.clenDph;
      }
      if (options.fault !== 'ledger') for (const row of state.ledger) row.clenDph = state.invoice.clenDph;
      if (options.fault === 'disconnect') throw new Error('connection lost after possible mutation');
      if (options.fault === 'money') state.invoice.sumDphCelkem = '99.00';
      if (options.fault === 'wrongReceipt') return json({ winstrom: { ...success().winstrom, results: [{ id: '999', ref: '/ignored' }] } });
      if (options.fault === 'commitWarning') return json({ winstrom: { ...success().winstrom, warnings: [{ code: 'unexpected.after-save-warning' }] } });
      return json(success());
    }
    assert.equal(init?.method, 'GET');
    await onRead?.();
    if (options.fault === 'verify' && state.writes) throw new Error('readback disconnected');
    if (url.pathname === '/c.json') return json({ companies: { company: ['a', 'b'].map(dbNazev => ({ dbNazev, nazev: dbNazev, show: 'true', stavEnum: 'ESTABLISHED' })) } });
    if (url.pathname.endsWith('/evidence-list.json')) return json({ evidences: { evidence: [
      { evidencePath: 'faktura-prijata', evidenceType: 'INVOICE', evidenceName: 'Invoice', evidenceAccess: 'true' },
      { evidencePath: 'faktura-prijata-polozka', evidenceType: 'ITEM', evidenceName: 'Items', evidenceAccess: 'true' },
      { evidencePath: 'ucetni-denik', evidenceType: 'LEDGER', evidenceName: 'Ledger', evidenceAccess: 'true' },
    ] } });
    if (url.pathname.endsWith('/relations.json')) return json({ relations: { relation: [{ url: 'polozkyDokladu', evidenceType: 'ITEM', name: 'Items' }] } });
    if (url.pathname.endsWith('/properties.json')) {
      if (url.pathname.includes('ucetni-denik/')) return json({ properties: { property: [prop('idUcetniDenik', 'integer'), prop('idDokl', 'integer'), prop('modulK', 'select'), prop('mdUcet', 'relation'), prop('dalUcet', 'relation'), prop('sumTuz', 'numeric'), prop('sumMen', 'numeric'), prop('typSzbDphK', 'select'), prop('szbDph', 'numeric'), prop('vatItem', 'logic'), prop('zuctovano', 'logic'), prop('clenDph', 'relation')] } });
      return json({ properties: { property: [prop('id', 'integer'), prop('kod', 'string'), prop('lastUpdate', 'datetime'), prop('doklFak', 'relation'), prop('clenDph', 'relation', options.writable !== false), prop('popis', 'string', true), prop('zklMdUcet', 'relation', true), prop('mnozMj', 'numeric', true), ...['sumZklCelkem', 'sumDphCelkem', 'sumCelkem', 'sumZkl', 'sumDph'].map(field => prop(field, 'numeric'))] } });
    }
    if (url.pathname.includes('/polozkyDokladu.json')) return json({ winstrom: { '@rowCount': String(state.items.length), 'faktura-prijata-polozka': state.items } });
    if (url.pathname.includes('/ucetni-denik')) {
      assert.match(decodeURIComponent(url.pathname), /idDokl eq 45 and modulK eq 'modulUcetni.FAP'/);
      return json({ winstrom: { '@rowCount': String(state.ledger.length), 'ucetni-denik': state.ledger } });
    }
    return json({ winstrom: { 'faktura-prijata': [state.invoice] } });
  } });
  let now = Date.parse('2026-10-26T12:30:00Z');
  const service = new InvoiceWriteService(config, registry, { now: () => now });
  store = service.store;
  const input: InvoiceWriteInput = { target: 'mock/a', invoiceId: '45', expectedCode: code, headerPatch: { clenDph: 'code:EU' }, items: [{ id: '11', patch: { clenDph: 'code:EU' } }], regenerateAccounting: true, accountingExpectation: { rows: state.ledger.map(row => ({ mdUcet: String(row.mdUcet), dalUcet: String(row.dalUcet), sumTuz: '21.0', vatItem: Boolean(row.vatItem), zuctovano: true, clenDph: 'code:EU' })).reverse() } };
  return { dir, state, config, registry, service, store, input, keys,
    setNow(value: number) { now = value; },
    onWrite(callback: () => Promise<void>) { onWrite = callback; },
    onRead(callback: () => Promise<void>) { onRead = callback; },
    approve: async (view: IntentView) => store.putApproval(view.id, signApproval(await store.get(view.id), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }))),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

test('prepare dry-runs an exact existing invoice/item CAS payload; signed commit verifies journal and replays receipt without another write', async () => {
  const f = await setup();
  try {
    const prepared = await f.service.prepare(f.input);
    assert.equal(prepared.status, 'prepared'); assert.equal(prepared.approval, 'required'); assert.equal(prepared.guardedItemCount, 2);
    assert.match(prepared.dryRunDigest, /^[a-f0-9]{64}$/);
    assert.equal(prepared.dryRunChanges.header.clenDph?.to, 'code:EU');
    const proposal = await f.store.get(prepared.id);
    assert.equal(proposal.dryRun.expected.invoice.sumDphCelkem, '21.00');
    assert.equal(proposal.dryRun.expected.items[0]?.record.sumCelkem, '121.00');
    assert.doesNotMatch(JSON.stringify(proposal.dryRun), /untrusted-gui|ignored-untrusted/);
    assert.equal(f.state.dryRuns, 1); assert.equal(f.state.writes, 0);
    assert.equal(f.state.invoice.clenDph, 'code:OLD');
    assert.equal((await stat(f.store.path)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.store.path, `${prepared.id}.proposal.json`))).mode & 0o777, 0o600);
    const native = ((f.state.puts[0]!.body.winstrom as Record<string, unknown>)['faktura-prijata'] as Record<string, unknown>[])[0]!;
    assert.equal(native['clenDph@previousValue'], 'code:OLD'); assert.equal(native.lastUpdate, OLD);
    await assert.rejects(f.service.commit('mock/a', prepared.id), { code: 'APPROVAL_REQUIRED' });
    await f.approve(prepared);
    f.onWrite(async () => { assert.equal((await f.store.readState(prepared.id)).status, 'committing', 'durable marker precedes PUT'); });
    const done = await f.service.commit('mock/a', prepared.id);
    assert.equal(done.status, 'succeeded'); assert.equal(done.accountingVerification, 'verified'); assert.equal(f.state.writes, 1);
    const replay = await f.service.commit('mock/a', prepared.id);
    assert.deepEqual(replay.receipt, done.receipt); assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

test('invoice identity, existing item membership, writable schema, raw actions and reparenting fail before any mutating request', async () => {
  const f = await setup();
  try {
    for (const value of [
      { ...f.input, expectedCode: 'OTHER' },
      { ...f.input, headerPatch: { id: '99' } },
      { ...f.input, headerPatch: { '@action': 'delete' } },
      { ...f.input, items: [{ id: '999', patch: { clenDph: 'code:EU' } }] },
      { ...f.input, items: [{ id: '11', patch: { doklFak: '46' } }] },
      { ...f.input, items: [{ id: '11', patch: { clenDph: 'code:EU' }, action: 'delete' }] },
      { ...f.input, regenerateAccounting: true, accountingExpectation: undefined },
    ]) await assert.rejects(f.service.prepare(value as InvoiceWriteInput));
    assert.equal(f.state.dryRuns, 0); assert.equal(f.state.writes, 0);
    f.state.items[0]!['doklFak@internalId'] = '46';
    await assert.rejects(f.service.prepare(f.input), { code: 'ITEM_PARENT_MISMATCH' });
  } finally { await f.close(); }
  const denied = await setup({ writable: false });
  try { await assert.rejects(denied.service.prepare(denied.input), { code: 'WRITE_FIELD_DENIED' }); assert.equal(denied.state.puts.length, 0); }
  finally { await denied.close(); }
});

test('changed approved snapshots or changed policy block commit, and native CAS conflicts are final without retries', async () => {
  const f = await setup();
  try {
    const prepared = await f.service.prepare(f.input); await f.approve(prepared);
    f.state.items[1]!.lastUpdate = NEW;
    const conflict = await f.service.commit('mock/a', prepared.id);
    assert.equal(conflict.status, 'conflict'); assert.equal(f.state.writes, 0);
    assert.equal((await f.service.commit('mock/a', prepared.id)).status, 'conflict');
  } finally { await f.close(); }
  const cas = await setup({ fault: 'conflict' });
  try {
    const prepared = await cas.service.prepare(cas.input); await cas.approve(prepared);
    assert.equal((await cas.service.commit('mock/a', prepared.id)).status, 'conflict');
    assert.equal((await cas.service.commit('mock/a', prepared.id)).status, 'conflict'); assert.equal(cas.state.writes, 1);
  } finally { await cas.close(); }
  const policy = await setup();
  try {
    const prepared = await policy.service.prepare(policy.input); await policy.approve(prepared);
    const changed: AppConfig = { ...policy.config, servers: policy.config.servers!.map(server => ({ ...server, companies: server.companies.map(company => ({ ...company, writePolicy: { enabled: true, headerFields: [], itemFields: [] } })) })) };
    const service = new InvoiceWriteService(changed, policy.registry);
    await assert.rejects(service.commit('mock/a', prepared.id), { code: 'INTENT_SCOPE_CHANGED' }); assert.equal(policy.state.writes, 0);
  } finally { await policy.close(); }
});

test('dry-run warnings or create statistics prevent preparation and an independently changed ledger invalidates approval', async () => {
  for (const fault of ['dryWarning', 'dryCreate', 'dryNoContent'] as const) {
    const f = await setup({ fault });
    try { await assert.rejects(f.service.prepare(f.input)); assert.equal(f.state.writes, 0); }
    finally { await f.close(); }
  }
  const ledger = await setup();
  try {
    const prepared = await ledger.service.prepare(ledger.input); await ledger.approve(prepared);
    ledger.state.ledger[0]!.sumTuz = '20.00';
    assert.equal((await ledger.service.commit('mock/a', prepared.id)).status, 'conflict'); assert.equal(ledger.state.writes, 0);
  } finally { await ledger.close(); }
});

test('operator signatures, expiry, target binding and proposal tampering cannot authorize a write', async () => {
  const f = await setup();
  try {
    const prepared = await f.service.prepare(f.input);
    await assert.rejects(f.service.status('mock/b', prepared.id), { code: 'INTENT_TARGET_MISMATCH' });
    await assert.rejects(f.service.commit('mock/b', prepared.id), { code: 'INTENT_TARGET_MISMATCH' });
    const wrong = generateKeyPairSync('ed25519');
    await f.store.putApproval(prepared.id, signApproval(await f.store.get(prepared.id), wrong.privateKey.export({ type: 'pkcs8', format: 'pem' })));
    await assert.rejects(f.service.commit('mock/a', prepared.id), { code: 'APPROVAL_INVALID' });
    assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
  const expired = await setup();
  try {
    const prepared = await expired.service.prepare(expired.input); await expired.approve(prepared);
    expired.setNow(Date.parse(prepared.expiresAt) + 1);
    await assert.rejects(expired.service.commit('mock/a', prepared.id), { code: 'INTENT_EXPIRED' }); assert.equal(expired.state.writes, 0);
  } finally { await expired.close(); }
  const tampered = await setup();
  try {
    const prepared = await tampered.service.prepare(tampered.input); await tampered.approve(prepared);
    const path = join(tampered.store.path, `${prepared.id}.proposal.json`);
    const proposal = JSON.parse(await readFile(path, 'utf8')); proposal.headerPatch.clenDph = 'code:OTHER';
    await writeFile(path, JSON.stringify(proposal));
    await assert.rejects(tampered.service.commit('mock/a', prepared.id), { code: 'WRITE_STORE_INVALID' });
    proposal.digest = proposalDigest(proposal); await writeFile(path, JSON.stringify(proposal));
    await assert.rejects(tampered.service.commit('mock/a', prepared.id), { code: 'APPROVAL_INVALID' }); assert.equal(tampered.state.writes, 0);
  } finally { await tampered.close(); }
});

test('weak accounting proofs are rejected before HTTP and approvals are rechecked after slow preflight reads', async () => {
  const f = await setup();
  try {
    await assert.rejects(f.service.prepare({ ...f.input, accountingExpectation: { rows: [{ clenDph: 'code:EU' }] } }), { code: 'INVALID_INPUT' });
    assert.equal(f.state.puts.length, 0);
    const prepared = await f.service.prepare(f.input); await f.approve(prepared);
    f.onRead(async () => { f.setNow(Date.parse(prepared.expiresAt) + 1); });
    await assert.rejects(f.service.commit('mock/a', prepared.id), { code: 'INTENT_EXPIRED' });
    assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test('disconnects, server failures, failed readback and missing journal updates remain unknown across service restart and are never replayed', async () => {
  for (const fault of ['disconnect', 'server', 'verify', 'ledger', 'wrongReceipt', 'money', 'commitWarning'] as const) {
    const f = await setup({ fault });
    try {
      const prepared = await f.service.prepare(f.input); await f.approve(prepared);
      const result = await f.service.commit('mock/a', prepared.id);
      assert.equal(result.status, 'unknown', fault); assert.equal(f.state.writes, 1);
      const restarted = new InvoiceWriteService(f.config, f.registry);
      assert.equal((await restarted.status('mock/a', prepared.id)).status, 'unknown');
      assert.equal((await restarted.commit('mock/a', prepared.id)).status, 'unknown'); assert.equal(f.state.writes, 1);
    } finally { await f.close(); }
  }
});

test('a persisted committing marker is unknown after restart and persistent cross-process locks prevent duplicate attempts', async () => {
  const f = await setup();
  try {
    const prepared = await f.service.prepare(f.input); await f.approve(prepared);
    const otherStore = new IntentStore(f.store.path);
    await f.store.withIntentLock(prepared.id, async () => {
      await assert.rejects(otherStore.withIntentLock(prepared.id, async () => undefined), { code: 'WRITE_BUSY' });
    });
    await f.store.withDocumentLock('same physical document', async () => {
      await assert.rejects(otherStore.withDocumentLock('same physical document', async () => undefined), { code: 'WRITE_BUSY' });
    });
    await f.store.writeState(prepared.id, { status: 'committing', updatedAt: new Date().toISOString() });
    const restarted = new InvoiceWriteService(f.config, f.registry);
    assert.equal((await restarted.status('mock/a', prepared.id)).status, 'unknown');
    assert.equal((await restarted.commit('mock/a', prepared.id)).status, 'unknown'); assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test('an unknown mutation fences the physical document against new and previously prepared intents', async () => {
  const f = await setup({ fault: 'server' });
  try {
    const first = await f.service.prepare(f.input); await f.approve(first);
    const second = await f.service.prepare(f.input); await f.approve(second);
    assert.equal((await f.service.commit('mock/a', first.id)).status, 'unknown');
    const restarted = new InvoiceWriteService(f.config, f.registry);
    await assert.rejects(restarted.prepare(f.input), { code: 'DOCUMENT_RECONCILIATION_REQUIRED' });
    await assert.rejects(restarted.commit('mock/a', second.id), { code: 'DOCUMENT_RECONCILIATION_REQUIRED' });
    assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

test('a crash after the durable fence but before the committing marker also requires reconciliation', async () => {
  const f = await setup();
  try {
    const prepared = await f.service.prepare(f.input); await f.approve(prepared);
    await f.store.putDocumentFence(canonicalJson({ origin: 'https://mock.example.test', database: 'a', invoiceId: '45' }), { intentId: prepared.id, target: prepared.target, digest: prepared.digest, createdAt: prepared.createdAt });
    assert.equal((await f.service.status('mock/a', prepared.id)).status, 'unknown');
    await assert.rejects(f.service.prepare(f.input), { code: 'DOCUMENT_RECONCILIATION_REQUIRED' });
    await assert.rejects(f.service.commit('mock/a', prepared.id), { code: 'DOCUMENT_RECONCILIATION_REQUIRED' });
    assert.equal(f.state.writes, 0);
  } finally { await f.close(); }
});

test('a persistence failure after dispatch returns typed uncertainty with the intent ID rather than a generic non-write error', async () => {
  const f = await setup();
  try {
    const prepared = await f.service.prepare(f.input); await f.approve(prepared);
    class FailureStore extends IntentStore {
      override async writeState(id: string, state: import('../src/write-store.ts').IntentState): Promise<void> {
        await super.writeState(id, state);
        if (state.status === 'succeeded') throw new Error('simulated fsync completion failure');
      }
    }
    const service = new InvoiceWriteService(f.config, f.registry, { store: new FailureStore(f.store.path), now: () => Date.parse(prepared.createdAt) });
    await assert.rejects(service.commit('mock/a', prepared.id), error => error instanceof Error && 'code' in error && error.code === 'WRITE_UNKNOWN' && error.message.includes(prepared.id));
    assert.equal(f.state.writes, 1);
    assert.equal((await service.status('mock/a', prepared.id)).status, 'succeeded');
  } finally { await f.close(); }
});

test('status and successful receipt replay cannot relabel an old database under a remapped target alias', async () => {
  const f = await setup();
  try {
    const prepared = await f.service.prepare(f.input); await f.approve(prepared);
    assert.equal((await f.service.commit('mock/a', prepared.id)).status, 'succeeded');
    const remapped: AppConfig = { ...f.config, servers: f.config.servers!.map(server => ({ ...server, companies: server.companies.map(company => ({ ...company, database: company.id === 'a' ? 'replacement' : company.database })) })) };
    const registry = new ConnectionRegistry(remapped, { fetch: async () => { throw new Error('No network may be used'); } });
    const service = new InvoiceWriteService(remapped, registry);
    await assert.rejects(service.status('mock/a', prepared.id), { code: 'INTENT_SCOPE_CHANGED' });
    await assert.rejects(service.commit('mock/a', prepared.id), { code: 'INTENT_SCOPE_CHANGED' });
    assert.equal(f.state.writes, 1);
  } finally { await f.close(); }
});

test('the narrow native builder rejects arbitrary operations and protects every row with create-fail and update-ok attributes', () => {
  const valid = { id: '45', lastUpdate: OLD, headerPatch: { clenDph: 'code:EU' }, previousHeader: { clenDph: 'code:OLD' }, items: [{ id: '11', lastUpdate: OLD, patch: { zklMdUcet: 'code:548' }, previous: { zklMdUcet: 'code:518' } }], dryRun: true };
  assert.ok(buildExistingInvoicePayload(valid));
  assert.throws(() => buildExistingInvoicePayload({ ...valid, headerPatch: { storno: true } }));
  assert.throws(() => buildExistingInvoicePayload({ ...valid, items: [{ ...valid.items[0]!, patch: { doklFak: '99' } }] }));
  assert.throws(() => buildExistingInvoicePayload({ ...valid, items: [{ ...valid.items[0]!, id: 'ext:NEW:1' }] }));
});
