#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { AuditLog } from './audit.ts';
import { loadConfig } from './config.ts';
import { createDependencies, createServer } from './server.ts';

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stderr.write('mcp-flexibee [--law-only]\nConfigure through environment variables; see README.md. stdout is reserved for MCP.\n');
    return;
  }
  if (process.argv.slice(2).some(value => value !== '--law-only')) throw new Error('Unsupported argument.');
  const config = loadConfig(process.env, process.cwd(), process.argv.includes('--law-only'));
  const audit = await AuditLog.create(config.auditPath);
  try {
    const dependencies = await createDependencies(config, audit);
    const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65_536 });
    const handle = serveStdio(() => createServer(config, dependencies), {
      transport, maxSubscriptions: 0,
      onerror: () => { process.stderr.write('MCP protocol error.\n'); },
    });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      try { await handle.close(); await audit.close(); } catch { process.exitCode = 1; }
    };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
    process.stdin.once('end', () => { void close(); });
  } catch (error) { await audit.close(); throw error; }
}

main().catch(() => {
  process.stderr.write('Startup failed. Check connection configuration, audit permissions and the pinned legal corpus.\n');
  process.exitCode = 1;
});
