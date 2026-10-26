import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadConfig } from '../src/config.ts';

/** Explicit operator invocation only. Three MCP calls; at most two bounded upstream GETs. */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (!config.flexi) throw new Error('Flexi is not configured.');
  const evidence = config.flexi.allowedEvidences[0]!;
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', MCP_AUDIT_PATH: config.auditPath };
  for (const name of ['FLEXI_BASE_URL', 'FLEXI_COMPANY', 'FLEXI_USERNAME', 'FLEXI_PASSWORD', 'FLEXI_CONNECTION_NAME', 'FLEXI_ALLOWED_EVIDENCES', 'FLEXI_TIMEOUT_MS', 'FLEXI_MAX_RESPONSE_BYTES', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  }
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js')], env, stderr: 'pipe' });
  transport.stderr?.on('data', () => undefined);
  const client = new Client({ name: 'mcp-flexibee-live-smoke', version: '0.1.0' });
  try {
    await client.connect(transport);
    for (const [name, args] of [
      ['server_info', {}],
      ['flexi_schema_get', { evidence }],
      ['flexi_record_list', { evidence, fields: ['id', 'kod'], pageSize: 1 }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error('Read-only check failed.');
      process.stdout.write(`${name}: OK\n`);
    }
    process.stdout.write('Read-only smoke passed. Record values were withheld from console output.\n');
  } finally { await client.close(); }
}

main().catch(() => {
  process.stderr.write('Read-only smoke failed. Check local configuration, the API read role, schema compatibility, and audit metadata. No upstream details are printed.\n');
  process.exitCode = 1;
});
