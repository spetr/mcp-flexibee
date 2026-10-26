import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

for (const entry of ['src/index.ts', 'dist/index.js']) {
for (const mode of ['legacy', 'modern'] as const) {
  test(`actual stdio ${entry} negotiates ${mode} MCP and exits cleanly`, { timeout: 15_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flexi-stdio-test-'));
    const auditPath = join(dir, 'audit.jsonl');
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(entry), '--law-only'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', MCP_AUDIT_PATH: auditPath }, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' }, { versionNegotiation: mode === 'modern' ? { mode: { pin: '2026-07-28' } } : { mode: 'legacy' } });
    try {
      await client.connect(transport);
      assert.equal(client.getProtocolEra(), mode === 'modern' ? 'modern' : 'legacy');
      const tools = await client.listTools();
      assert.ok(tools.tools.some(tool => tool.name === 'czlaw_search'));
      assert.ok(!tools.tools.some(tool => tool.name.startsWith('flexi_record')));
      const result = await client.callTool({ name: 'server_info', arguments: {} });
      assert.equal(result.isError, undefined);
      assert.match(JSON.stringify(result.structuredContent), /not_ready/);
      const audit = await readFile(auditPath, 'utf8'); assert.match(audit, /server_info/);
      assert.equal(stderr, '');
    } finally {
      await client.close();
      await assert.rejects(readFile(`${auditPath}.lock`), { code: 'ENOENT' });
      await rm(dir, { recursive: true, force: true });
    }
  });
}
}

for (const mode of ['legacy', 'modern'] as const) {
  test(`actual multi-company stdio negotiates ${mode} without selecting an implicit company`, { timeout: 15_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flexi-multi-stdio-'));
    const configPath = join(dir, 'connections.json');
    const auditPath = join(dir, 'audit.jsonl');
    await writeFile(configPath, JSON.stringify({ version: 1, readOnly: true, servers: [{
      id: 'fixture', label: 'Fixture', baseUrl: 'https://never-contacted.example.test',
      credentials: { reader: { usernameEnv: 'TEST_FLEXI_USER', passwordEnv: 'TEST_FLEXI_PASSWORD' } },
      companies: ['a', 'b'].map(id => ({ id, label: id, database: id, credentialId: 'reader', environment: 'test', allowedEvidences: ['*'] })),
    }] }), { mode: 0o600 });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')], env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', FLEXI_CONFIG_PATH: configPath, MCP_AUDIT_PATH: auditPath,
      TEST_FLEXI_USER: 'fixture', TEST_FLEXI_PASSWORD: 'fixture-password-do-not-expose',
    }, stderr: 'pipe' });
    let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
    const client = new Client({ name: 'multi-stdio-test', version: '1' }, { versionNegotiation: mode === 'modern' ? { mode: { pin: '2026-07-28' } } : { mode: 'legacy' } });
    try {
      await client.connect(transport);
      assert.equal((await client.listTools()).tools.length, 13);
      const targets = await client.callTool({ name: 'flexi_target_list', arguments: { pageSize: 1 } });
      assert.ok(!targets.isError); assert.doesNotMatch(JSON.stringify(targets), /fixture-password-do-not-expose/);
      const missing = await client.callTool({ name: 'flexi_record_list', arguments: { evidence: 'faktura-prijata', fields: ['id'], pageSize: 1 } });
      assert.equal(missing.isError, true); assert.match(JSON.stringify(missing), /TARGET_REQUIRED/);
      assert.ok(!(await client.callTool({ name: 'czlaw_status', arguments: {} })).isError);
      assert.equal(stderr, '');
      const audit = await readFile(auditPath, 'utf8'); assert.match(audit, /unresolved/); assert.doesNotMatch(audit, /fixture-password-do-not-expose/);
    } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
