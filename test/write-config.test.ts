import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.ts';

test('write configuration requires explicit target fields, public-key/store setup and a runtime-schema target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flexi-write-config-'));
  const file = join(dir, 'connections.json');
  const env = { FLEXI_CONFIG_PATH: file, API_USER: 'reader', API_PASSWORD: 'fixture-secret' };
  const company = { id: 'production', label: 'Production', database: 'production', credentialId: 'reader', environment: 'production', allowedEvidences: ['*'], writePolicy: { enabled: true, headerFields: ['clenDph'], itemFields: ['clenDph'] } };
  const document = { version: 1, readOnly: false, write: { storePath: 'intents', approvalPublicKeyPath: 'operator.pub' }, servers: [{ id: 'server', label: 'Server', baseUrl: 'https://example.test', credentials: { reader: { usernameEnv: 'API_USER', passwordEnv: 'API_PASSWORD' } }, companies: [company] }] };
  const check = (value: unknown) => { writeFileSync(file, JSON.stringify(value)); return loadConfig(env); };
  try {
    const config = check(document);
    assert.equal(config.writeStorePath, join(dir, 'intents'));
    assert.equal(config.writeApprovalPublicKeyPath, join(dir, 'operator.pub'));
    assert.equal(config.servers?.[0]?.companies[0]?.writePolicy?.enabled, true);
    assert.ok(Object.isFrozen(config.servers?.[0]?.companies[0]?.writePolicy?.headerFields));
    assert.throws(() => check({ ...document, readOnly: true }));
    const { write: _omit, ...noKey } = document;
    assert.throws(() => check(noKey));
    for (const changed of [
      { ...company, allowedEvidences: ['faktura-prijata'] },
      { ...company, writePolicy: { ...company.writePolicy, headerFields: ['id'] } },
      { ...company, writePolicy: { ...company.writePolicy, itemFields: ['doklFak'] } },
      { ...company, writePolicy: { enabled: true, headerFields: [], itemFields: [] } },
    ]) assert.throws(() => check({ ...document, servers: [{ ...document.servers[0], companies: [changed] }] }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
