import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLog } from '../src/audit.ts';
import { CursorSigner } from '../src/cursor.ts';
import { loadConfig } from '../src/config.ts';

test('audit append serialization survives restart and detects tampering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flexi-audit-test-'));
  const path = join(dir, 'audit.jsonl');
  try {
    const log = await AuditLog.create(path);
    await Promise.all(Array.from({ length: 20 }, (_, index) => log.record({ requestId: String(index), at: '2026-10-26T00:00:00Z', operation: 'test', connection: 'main', outcome: 'success' })));
    await log.close();
    const reopened = await AuditLog.create(path);
    await reopened.record({ requestId: '21', at: '2026-10-26T00:00:00Z', operation: 'test', connection: 'main', outcome: 'success' });
    await reopened.close();
    const content = await readFile(path, 'utf8');
    assert.equal(content.trim().split('\n').length, 21);
    await writeFile(path, content.replace('"requestId":"0"', '"requestId":"altered"'));
    await assert.rejects(AuditLog.create(path), /Invalid audit chain/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('audit rejects world-readable files and symlink targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flexi-audit-test-'));
  try {
    const path = join(dir, 'audit.jsonl');
    await writeFile(path, '', { mode: 0o644 }); await chmod(path, 0o644);
    await assert.rejects(AuditLog.create(path), /Unsafe/);
    await symlink(path, join(dir, 'linked'));
    await assert.rejects(AuditLog.create(join(dir, 'linked')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('exclusive audit lease prevents concurrent writers from forking the chain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flexi-audit-lock-test-'));
  const path = join(dir, 'audit.jsonl');
  try {
    const one = await AuditLog.create(path);
    await assert.rejects(AuditLog.create(path), { code: 'EEXIST' });
    await one.record({ requestId: 'one', at: '2026-10-26T00:00:00Z', operation: 'test', connection: 'main', outcome: 'success' });
    await one.close();
    const two = await AuditLog.create(path);
    await two.record({ requestId: 'two', at: '2026-10-26T00:00:00Z', operation: 'test', connection: 'main', outcome: 'success' });
    await two.close();
    const three = await AuditLog.create(path); await three.close();
    await writeFile(`${path}.lock`, 'stale-or-live-pid\n', { mode: 0o600 });
    await assert.rejects(AuditLog.create(path), { code: 'EEXIST' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cursor rejects tampering, replay under different query/instance, and expiry', () => {
  let now = 1_000;
  const signer = new CursorSigner(() => now);
  const query = { company: 'a', evidence: 'faktura-vydana', fields: ['id'] };
  const token = signer.issue(query, 20);
  assert.equal(signer.verify(token, query), 20);
  assert.throws(() => signer.verify(token, { ...query, company: 'b' }));
  assert.throws(() => signer.verify(`${token}x`, query));
  assert.throws(() => new CursorSigner().verify(token, query));
  now += 900_000;
  assert.throws(() => signer.verify(token, query));
});

test('configuration requires complete credentials and pins reviewed law manifest', () => {
  assert.throws(() => loadConfig({ FLEXI_BASE_URL: 'https://example.test' }));
  assert.throws(() => loadConfig({ CZLAW_CORPUS_PATH: 'release.json' }));
  assert.throws(() => loadConfig({ FLEXI_BASE_URL: 'https://example.test', FLEXI_COMPANY: 'a', FLEXI_USERNAME: 'api', FLEXI_PASSWORD: 'secret' }, process.cwd(), true));
  assert.throws(() => loadConfig({ MCP_CALLS_PER_MINUTE: 'Infinity' }));
  const config = loadConfig({}); assert.equal(config.flexi, undefined); assert.equal(config.callsPerMinute, 60);
});
