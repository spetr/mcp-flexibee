import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig } from '../src/config.ts';

/** Explicit operator invocation only. Metadata and at most one invoice per target; no writes. */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const requested = process.argv.slice(2);
  if (requested.length > 1 || (requested[0] && !requested[0].startsWith('--target='))) throw new Error('Unsupported argument.');
  const selected = requested[0]?.slice('--target='.length);
  const targets = config.servers ? config.servers.flatMap(server => server.companies.map(company => ({ target: `${server.id}/${company.id}`, policy: company.allowedEvidences }))) : config.flexi ? [{ target: undefined, policy: config.flexi.allowedEvidences }] : [];
  const checks = selected ? targets.filter(item => item.target === selected) : targets;
  if (!checks.length || checks.length > 8) throw new Error('Choose an explicit configured target (at most eight targets per smoke).');
  const names = new Set(['FLEXI_CONFIG_PATH', 'FLEXI_BASE_URL', 'FLEXI_COMPANY', 'FLEXI_USERNAME', 'FLEXI_PASSWORD', 'FLEXI_CONNECTION_NAME', 'FLEXI_ALLOWED_EVIDENCES', 'FLEXI_TIMEOUT_MS', 'FLEXI_MAX_RESPONSE_BYTES', 'NODE_EXTRA_CA_CERTS']);
  if (process.env.FLEXI_CONFIG_PATH) {
    const raw = JSON.parse(readFileSync(resolve(process.env.FLEXI_CONFIG_PATH), 'utf8')) as { servers: { credentials: Record<string, { usernameEnv: string; passwordEnv: string }> }[] };
    for (const server of raw.servers) for (const profile of Object.values(server.credentials)) { names.add(profile.usernameEnv); names.add(profile.passwordEnv); }
  }
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', MCP_AUDIT_PATH: config.auditPath };
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name]!;
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')], env, stderr: 'pipe' });
  transport.stderr?.on('data', () => undefined);
  const client = new Client({ name: 'mcp-flexibee-live-smoke', version: '0.3.0' });
  try {
    await client.connect(transport);
    for (const item of checks) {
      const scope = item.target ? { target: item.target } : {};
      const evidence = item.policy.includes('*') || item.policy.includes('faktura-prijata') ? 'faktura-prijata' : item.policy[0]!;
      for (const [name, args] of [
        ['server_info', scope], ['flexi_schema_get', { ...scope, evidence }],
        ['flexi_record_list', { ...scope, evidence, fields: ['id', 'kod'], pageSize: 1 }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) throw new Error('Read-only check failed.');
        process.stdout.write(`${item.target ?? 'legacy'} ${name}: OK\n`);
      }
    }
    process.stdout.write('Read-only smoke passed. Record values and credentials were withheld.\n');
  } finally { await client.close(); }
}
main().catch(() => { process.stderr.write('Read-only smoke failed. Check target, discovery/access, configuration, and audit metadata. No upstream details are printed.\n'); process.exitCode = 1; });
