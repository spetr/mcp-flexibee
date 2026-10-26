import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { LAW_REGIMES, LAW_TOPICS, LawService, LawValidationError } from '../src/law/index.ts';
import type { CorpusManifest, LawSearchInput } from '../src/law/index.ts';

// All normative-looking fixtures are invented test strings, created only in tmp.
// They must never be used as a reviewed or published legal corpus.
const NOW = new Date('2026-10-26T10:00:00.000Z');
const textA = 'SYNTHETIC TEST ONLY — invented provision version A, no legal meaning.';
const textB = 'SYNTHETIC TEST ONLY — invented provision version B, no legal meaning.';
const snapshot = `${textA}\n${textB}\n`;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const request: LawSearchInput = { asOf: '2026-10-26', regime: 'accounting', topics: ['records'] };

function manifest(): CorpusManifest {
  return {
    schemaVersion: 1, releaseId: 'synthetic-tests-only-2026-10', classification: 'public_legislation',
    publishedAt: '2026-10-23T00:00:00.000Z',
    approval: { status: 'approved', reviewedBy: 'synthetic-test-reviewer', reviewedAt: '2026-10-22T00:00:00.000Z' },
    coverage: LAW_REGIMES.flatMap(regime => LAW_TOPICS.map(topic => ({
      regime, topic, status: 'complete' as const, effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01',
    }))),
    documents: [{
      id: 'synthetic-source', title: 'SYNTHETIC TEST ONLY — no legal meaning',
      sourceKind: 'law', officialUrl: 'https://e-sbirka.gov.cz/sb/1991/563',
      retrievedAt: '2026-10-20T00:00:00.000Z', verifiedAt: '2026-10-21T00:00:00.000Z',
      snapshot: { path: 'synthetic.txt', sha256: hash(snapshot) },
      fragments: [
        { id: 'synthetic:p1', provision: 'SYNTHETIC § 1', regimes: [...LAW_REGIMES], topics: [...LAW_TOPICS], text: textA, sha256: hash(textA), effectiveFrom: '2026-01-01', effectiveTo: '2026-07-01' },
        { id: 'synthetic:p1', provision: 'SYNTHETIC § 1', regimes: [...LAW_REGIMES], topics: [...LAW_TOPICS], text: textB, sha256: hash(textB), effectiveFrom: '2026-07-01', effectiveTo: '2027-01-01' },
      ],
    }],
  };
}

async function fixture(t: TestContext, mutate?: (value: CorpusManifest) => void): Promise<{ dir: string; manifestPath: string; value: CorpusManifest }> {
  const dir = await mkdtemp(join(tmpdir(), 'law-synthetic-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const value = manifest();
  mutate?.(value);
  const manifestPath = join(dir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(value));
  await writeFile(join(dir, 'synthetic.txt'), snapshot);
  return { dir, manifestPath, value };
}

test('empty installation returns honest not_ready status and official discovery links', async () => {
  const service = await LawService.create({ now: () => NOW });
  const result = service.search(request);
  assert.equal(result.status, 'not_ready');
  assert.equal(result.release, null);
  assert.equal(result.fragments.length, 0);
  assert.equal(result.documentCount, 0);
  assert.ok(result.officialSources.some(source => source.sourceKind === 'guidance'));
  assert.ok(result.reasons.some(reason => reason.includes('No approved normative corpus')));
  assert.equal(service.getProvision({ id: 'anything', asOf: request.asOf }).status, 'not_ready');
});

test('loads explicit directory/file with hash pin and returns exact release-bound citations', async t => {
  const { dir, manifestPath } = await fixture(t);
  const pin = createHash('sha256').update(await readFile(manifestPath)).digest('hex');
  const service = await LawService.create({ corpusPath: dir, expectedManifestSha256: pin, now: () => NOW });
  assert.equal(service.status().status, 'ready');
  const result = service.search(request);
  assert.equal(result.status, 'ready');
  assert.equal(result.fragments[0]?.text, textB);
  assert.equal(result.fragments[0]?.provision, 'SYNTHETIC § 1');
  assert.equal(result.fragments[0]?.snapshotSha256, hash(snapshot));
  assert.equal(result.fragments[0]?.manifestSha256, pin);
  assert.equal(result.release?.id, 'synthetic-tests-only-2026-10');
  assert.equal(result.freshness.oldestVerifiedAt, '2026-10-21T00:00:00.000Z');
  assert.equal((await LawService.create({ corpusPath: manifestPath, now: () => NOW })).search(request).status, 'ready');
});

test('effectiveTo is exclusive, adjacent versions select exactly one and outside coverage fails closed', async t => {
  const { dir } = await fixture(t);
  const service = await LawService.create({ corpusPath: dir, now: () => NOW });
  assert.equal(service.getProvision({ id: 'synthetic:p1', asOf: '2026-06-30' }).fragments[0]?.text, textA);
  assert.equal(service.getProvision({ id: 'synthetic:p1', asOf: '2026-07-01' }).fragments[0]?.text, textB);
  assert.equal(service.getProvision({ id: 'synthetic:p1', asOf: '2027-01-01' }).fragments.length, 0);
  assert.equal(service.search({ ...request, asOf: '2025-12-31' }).status, 'not_ready');
  assert.equal(service.search({ ...request, asOf: '2027-01-01' }).status, 'not_ready');
});

test('rejects invalid civil dates, missing asOf, firm text, unknown keys/regimes/topics, and unsafe limits', async () => {
  const service = await LawService.create({ now: () => NOW });
  for (const asOf of ['2026-02-29', '2026-04-31', '0000-01-01', '2026-13-01', '2026-1-01', '2026-10-26T00:00:00Z', 'today', undefined]) {
    assert.throws(() => service.search({ ...request, asOf } as LawSearchInput), LawValidationError);
  }
  for (const extra of [{ query: 'my company invoice' }, { regime: 'arbitrary' }, { topics: ['customer-address'] }, { topics: [] }, { topics: ['records', 'records'] }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }]) {
    assert.throws(() => service.search({ ...request, ...extra } as LawSearchInput), LawValidationError);
  }
  assert.equal(service.search({ ...request, asOf: '2024-02-29' }).asOf, '2024-02-29');
});

test('staleness is evaluated at each query and covers retrieval as well as verification', async t => {
  const { dir } = await fixture(t);
  let now = NOW;
  const service = await LawService.create({ corpusPath: dir, maxAgeDays: 30, now: () => now });
  now = new Date('2026-11-19T00:00:00.000Z'); // retrieval is exactly 30 days old
  assert.equal(service.search(request).status, 'ready');
  now = new Date('2026-11-19T00:00:00.001Z');
  const result = service.search(request);
  assert.equal(result.status, 'not_ready');
  assert.deepEqual(result.fragments, []);
  assert.deepEqual(result.freshness.staleDocumentIds, ['synthetic-source']);
  assert.equal(service.getProvision({ id: 'synthetic:p1', asOf: '2026-02-01' }).status, 'not_ready');
});

test('partial reviewed coverage never labels the whole corpus ready and blocks missing topic combinations', async t => {
  const { dir } = await fixture(t, value => { value.coverage = value.coverage.filter(row => row.regime === 'accounting' && row.topic === 'records'); });
  const service = await LawService.create({ corpusPath: dir, now: () => NOW });
  assert.equal(service.status().status, 'not_ready');
  assert.equal(service.search(request).status, 'ready');
  assert.equal(service.search({ ...request, topics: ['records', 'vat'] }).status, 'not_ready');
  assert.equal(service.search({ ...request, regime: 'tax_evidence' }).fragments.length, 0);
  assert.equal(service.getProvision({ id: 'synthetic:p1', asOf: request.asOf }).status, 'not_ready');
});

test('rejects edited snapshot bytes, fragment digest and fragment absent from the full text', async t => {
  const a = await fixture(t);
  await writeFile(join(a.dir, 'synthetic.txt'), `${snapshot}tampered`);
  await assert.rejects(LawService.create({ corpusPath: a.dir, now: () => NOW }), /Snapshot SHA-256 mismatch/);
  const b = await fixture(t, value => { value.documents[0]!.fragments[0]!.text = 'changed'; });
  await assert.rejects(LawService.create({ corpusPath: b.dir, now: () => NOW }), /Fragment SHA-256 mismatch/);
  const c = await fixture(t, value => {
    value.documents[0]!.fragments[0]!.text = 'SYNTHETIC MISSING TEXT';
    value.documents[0]!.fragments[0]!.sha256 = hash('SYNTHETIC MISSING TEXT');
  });
  await assert.rejects(LawService.create({ corpusPath: c.dir, now: () => NOW }), /not verbatim/);
  const d = await fixture(t);
  await assert.rejects(LawService.create({ corpusPath: d.dir, expectedManifestSha256: '0'.repeat(64), now: () => NOW }), /Manifest SHA-256 pin mismatch/);
});

test('rejects overlapping versions, overlapping coverage and unsupported coverage gaps', async t => {
  const a = await fixture(t, value => { value.documents[0]!.fragments[1]!.effectiveFrom = '2026-06-30'; });
  await assert.rejects(LawService.create({ corpusPath: a.dir, now: () => NOW }), /Overlapping versions/);
  const b = await fixture(t, value => { value.coverage.push({ ...value.coverage[0]! }); });
  await assert.rejects(LawService.create({ corpusPath: b.dir, now: () => NOW }), /Overlapping coverage/);
  const c = await fixture(t, value => { value.documents[0]!.fragments[1]!.effectiveFrom = '2026-07-02'; });
  await assert.rejects(LawService.create({ corpusPath: c.dir, now: () => NOW }), /not supported by fragment intervals/);
});

test('open-ended reviewed intervals support today but never produce future legal conclusions', async t => {
  const { dir } = await fixture(t, value => {
    value.documents[0]!.fragments[1]!.effectiveTo = null;
    value.coverage.forEach(row => { row.effectiveTo = null; });
  });
  const service = await LawService.create({ corpusPath: dir, now: () => NOW });
  assert.equal(service.search(request).status, 'ready');
  for (const result of [
    service.search({ ...request, asOf: '2028-01-01' }),
    service.getProvision({ id: 'synthetic:p1', asOf: '2028-01-01' }),
  ]) {
    assert.equal(result.status, 'not_ready');
    assert.ok(result.reasons.includes('future_as_of_not_supported'));
    assert.deepEqual(result.fragments, []);
    assert.equal(result.totalMatches, 0);
  }
});

test('future cutoff and global status use Prague midnight, including when UTC has the previous date', async t => {
  const { dir } = await fixture(t, value => {
    value.coverage.forEach(row => { row.effectiveFrom = '2026-10-27'; });
  });
  let now = new Date('2026-10-26T22:59:59.999Z'); // Prague 23:59:59.999, after DST ended
  const service = await LawService.create({ corpusPath: dir, now: () => now });
  assert.equal(service.status().status, 'not_ready'); // coverage begins tomorrow locally
  assert.ok(service.search({ ...request, asOf: '2026-10-27' }).reasons.includes('future_as_of_not_supported'));
  assert.ok(service.getProvision({ id: 'synthetic:p1', asOf: '2026-10-27' }).reasons.includes('future_as_of_not_supported'));

  now = new Date('2026-10-26T23:00:00.000Z'); // Prague 2026-10-27, UTC remains 2026-10-26
  assert.equal(service.status().status, 'ready');
  assert.equal(service.search({ ...request, asOf: '2026-10-27' }).status, 'ready');
  assert.equal(service.getProvision({ id: 'synthetic:p1', asOf: '2026-10-27' }).status, 'ready');
  assert.ok(service.search({ ...request, asOf: '2026-10-28' }).reasons.includes('future_as_of_not_supported'));
});

test('official URLs require exact primary host and HTTPS without credentials or custom port', async t => {
  for (const url of [
    'https://mfcr.cz.evil.test/a', 'https://evil.test/mfcr.cz', 'http://mfcr.cz/a',
    'https://user:pass@mfcr.cz/a', 'https://mfcr.cz:8443/a', 'https://sub.mfcr.cz/a',
    'file:///tmp/source', 'https://mfcr.cz./a',
  ]) {
    const { dir } = await fixture(t, value => { value.documents[0]!.officialUrl = url; });
    await assert.rejects(LawService.create({ corpusPath: dir, now: () => NOW }), /officialUrl/);
  }
});

test('requires approval/reviewer, supported schema, public classification, and chronological timestamps', async t => {
  const changes: ((value: CorpusManifest) => void)[] = [
    value => { (value.approval as { status: string }).status = 'draft'; },
    value => { value.approval.reviewedBy = ''; },
    value => { (value as { schemaVersion: number }).schemaVersion = 2; },
    value => { (value as { classification: string }).classification = 'company_invoices'; },
    value => { value.documents[0]!.verifiedAt = '2026-10-27T00:00:00.000Z'; },
    value => { value.documents[0]!.retrievedAt = '2026-10-22T00:00:00.000Z'; },
    value => { value.approval.reviewedAt = '2026-10-20T00:00:00.000Z'; },
    value => { value.publishedAt = '2026-10-21T00:00:00.000Z'; },
    value => { value.documents[0]!.retrievedAt = '2026-02-30T00:00:00.000Z'; },
  ];
  for (const change of changes) {
    const { dir } = await fixture(t, change);
    await assert.rejects(LawService.create({ corpusPath: dir, now: () => NOW }), LawValidationError);
  }
});

test('blocks snapshot traversal and symlink escape from configured corpus root', async t => {
  const a = await fixture(t, value => { value.documents[0]!.snapshot.path = '../synthetic.txt'; });
  await assert.rejects(LawService.create({ corpusPath: a.dir, now: () => NOW }), /relative path/);
  const b = await fixture(t, value => { value.documents[0]!.snapshot.path = 'escape.txt'; });
  const outside = await mkdtemp(join(tmpdir(), 'law-synthetic-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'outside.txt'), snapshot);
  await symlink(join(outside, 'outside.txt'), join(b.dir, 'escape.txt'));
  await assert.rejects(LawService.create({ corpusPath: b.dir, now: () => NOW }), /outside corpus/);
});

test('release is memory-resident and returned values cannot change later query results', async t => {
  const { dir } = await fixture(t);
  const service = await LawService.create({ corpusPath: dir, now: () => NOW });
  const result = service.search(request);
  result.fragments[0]!.text = 'tampered result';
  result.fragments[0]!.topics.length = 0;
  result.coverage.length = 0;
  result.officialSources.length = 0;
  await writeFile(join(dir, 'manifest.json'), '{}');
  assert.equal(service.search(request).fragments[0]?.text, textB);
  assert.equal(service.status().status, 'ready');
  assert.ok(service.status().officialSources.length > 0);
});

test('bounded limit reports truncation without hiding total match count', async t => {
  const { dir } = await fixture(t, value => {
    value.documents[0]!.fragments.push({ ...value.documents[0]!.fragments[1]!, id: 'synthetic:p2', provision: 'SYNTHETIC § 2' });
  });
  const service = await LawService.create({ corpusPath: dir, now: () => NOW });
  const result = service.search({ ...request, limit: 1 });
  assert.equal(result.fragments.length, 1);
  assert.equal(result.totalMatches, 2);
  assert.equal(result.truncated, true);
});
